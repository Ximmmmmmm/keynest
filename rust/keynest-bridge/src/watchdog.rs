//! 请求超时看门狗，以及"握手必须在 N 毫秒内完成"的执行路径。
//!
//! # 为什么需要它
//!
//! 阶段 1 里 `REQUEST_TIMEOUT_MS` 只是一个常量，没有任何代码读它——
//! 于是"超时"这件事只存在于文档里。真实后果是：一个卡住的客户端
//! 能把 GUI 的服务线程永久占住，而浏览器那边只能干等。
//!
//! # 为什么不用异步
//!
//! 命名管道的读写是阻塞的，超时语义必须落在"谁来打断阻塞调用"上。
//! 引入 async 运行时只为了一处超时，代价（依赖、复杂度、panic 语义）
//! 远高于收益。这里用最直白的办法：**一个看门狗线程 + 一个取消回调**，
//! 到期就调用回调（GUI 侧是 `DisconnectNamedPipe`），把阻塞的读直接打断。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::error::BridgeError;

/// 由调用方提供的"打断阻塞"动作。
///
/// 服务端传 `DisconnectNamedPipe`，测试里传一个记录用的闭包。
pub type CancelFn = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct State {
    /// 当前这一次请求的截止时间；None 表示没有在等任何东西。
    deadline: Option<Instant>,
    /// 是否已经因为超时触发过取消。
    fired: bool,
    shutdown: bool,
}

/// 请求看门狗。
pub struct Watchdog {
    state: Arc<(Mutex<State>, Condvar)>,
    fired: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Watchdog {
    /// 起一个后台线程盯着截止时间。
    pub fn start(timeout: Duration, cancel: CancelFn) -> Self {
        let state = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let fired = Arc::new(AtomicBool::new(false));

        let s = Arc::clone(&state);
        let f = Arc::clone(&fired);
        let handle = std::thread::spawn(move || {
            let (lock, cvar) = &*s;
            loop {
                let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                if guard.shutdown {
                    return;
                }
                match guard.deadline {
                    None => {
                        // 空闲时睡到有人 arm 或要求退出
                        let (g, _) = cvar
                            .wait_timeout(guard, Duration::from_millis(200))
                            .unwrap_or_else(|e| e.into_inner());
                        guard = g;
                        if guard.shutdown {
                            return;
                        }
                    }
                    Some(dl) => {
                        let now = Instant::now();
                        if now >= dl {
                            guard.fired = true;
                            drop(guard);
                            f.store(true, Ordering::SeqCst);
                            cancel();
                            // 触发一次就退出：连接已被打断，后续请求没有意义
                            return;
                        }
                        let wait = dl.saturating_duration_since(now);
                        let (g, _) = cvar
                            .wait_timeout(guard, wait.min(Duration::from_millis(50)))
                            .unwrap_or_else(|e| e.into_inner());
                        guard = g;
                        let _ = timeout;
                    }
                }
            }
        });

        Self {
            state,
            fired,
            handle: Some(handle),
        }
    }

    /// 开始计时一次请求。
    pub fn arm(&self, timeout: Duration) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        guard.deadline = Some(Instant::now() + timeout);
        cvar.notify_all();
    }

    /// 请求已完成，停止计时。
    pub fn disarm(&self) {
        let (lock, cvar) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        guard.deadline = None;
        cvar.notify_all();
    }

    /// 是否已经因为超时打断过连接。
    pub fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        {
            let (lock, cvar) = &*self.state;
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            guard.shutdown = true;
            cvar.notify_all();
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 用截止时间包住一段同步工作。
///
/// 注意语义：**它不会中断已经开始的阻塞调用**，只会告诉你"这次超时了"。
/// 真正打断阻塞要靠上面的看门狗线程。
pub fn guard<T>(
    deadline: Instant,
    work: impl FnOnce() -> Result<T, BridgeError>,
) -> Result<T, BridgeError> {
    if Instant::now() >= deadline {
        return Err(BridgeError::Timeout);
    }
    let out = work()?;
    if Instant::now() >= deadline {
        // 工作完成但已超时：结果作废，避免把过期数据发给浏览器
        return Err(BridgeError::Timeout);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn watchdog_fires_when_deadline_passes() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let wd = Watchdog::start(
            Duration::from_millis(30),
            Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        wd.arm(Duration::from_millis(30));
        std::thread::sleep(Duration::from_millis(150));
        assert!(wd.fired(), "超过截止时间后必须触发");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "取消回调恰好一次");
    }

    #[test]
    fn watchdog_does_not_fire_when_disarmed_in_time() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let wd = Watchdog::start(
            Duration::from_millis(100),
            Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }),
        );
        wd.arm(Duration::from_millis(100));
        std::thread::sleep(Duration::from_millis(10));
        wd.disarm();
        std::thread::sleep(Duration::from_millis(150));
        assert!(!wd.fired(), "按时完成不应触发取消");
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn guard_rejects_expired_deadline() {
        let past = Instant::now() - Duration::from_millis(1);
        let r: Result<(), BridgeError> = guard(past, || Ok(()));
        assert!(matches!(r, Err(BridgeError::Timeout)));
    }

    #[test]
    fn guard_passes_through_fast_work() {
        let future = Instant::now() + Duration::from_secs(5);
        let r = guard(future, || Ok(42));
        assert_eq!(r.unwrap(), 42);
    }

    #[test]
    fn watchdog_stops_cleanly_on_drop() {
        let wd = Watchdog::start(Duration::from_millis(50), Box::new(|| {}));
        drop(wd); // 不应 panic、不应留下僵尸线程
    }
}
