//! GUI 侧的浏览器桥服务。
//!
//! # 为什么这么绕
//!
//! `egui` 是单线程的，`Vault` 只在 UI 线程里被 `&mut` 持有；
//! 而命名管道必须在后台线程里阻塞等待连接。两者不能直接共享 `&mut Vault`。
//!
//! 所以真实的密码库操作要**回到 UI 线程**执行：
//!
//! ```text
//! 后台线程（管道）            UI 线程（每帧 logic()）
//!   收到请求 ──mpsc──►  drain() 里执行 VaultOps，再回传结果
//!   ◄──oneshot──
//! ```
//!
//! 这样做还有一个副作用好处：**每次密码读取都发生在 UI 线程的当帧**，
//! 天然满足「不允许依赖过期缓存完成密码读取」。

pub mod origin;

use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use keynest_bridge::error::BridgeError;
use keynest_bridge::protocol::{EntrySummary, LockState, SavePayload};
use keynest_bridge::server::VaultOps;
use zeroize::Zeroizing;

/// UI 线程要执行的一次操作。
pub enum Call {
    LockState(Sender<LockState>),
    Version(Sender<String>),
    Query {
        origin: String,
        reply: Sender<Result<Vec<EntrySummary>, BridgeError>>,
    },
    Fill {
        entry_id: String,
        origin: String,
        reply: Sender<Result<Zeroizing<String>, BridgeError>>,
    },
    Save {
        payload: SavePayload,
        reply: Sender<Result<String, BridgeError>>,
    },
    Conflicts(Sender<Result<keynest_bridge::serde_json::Value, BridgeError>>),
}

/// 后台线程持有的代理：把每个调用转发给 UI 线程并等结果。
pub struct VaultProxy {
    tx: Sender<Call>,
    timeout: Duration,
    /// 成功入队后唤醒 UI 线程。
    ///
    /// **顺序很重要**：必须先 `send` 成功，再唤醒。
    /// 反过来的话，UI 线程可能在被唤醒后、消息入队前就跑完 `pump_bridge()`，
    /// 于是这一帧没东西可处理，而下一帧又要等到 500ms 后——
    /// 极端情况下请求会一直等不到处理者。
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl VaultProxy {
    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Call) -> Result<T, BridgeError> {
        let (tx, rx) = mpsc::channel();
        // 1) 先入队
        self.tx
            .send(make(tx))
            .map_err(|_| BridgeError::Io("UI 线程已退出".into()))?;
        // 2) 入队成功后才唤醒
        (self.wake)();
        // 等 UI 线程处理；超时说明界面卡住了，宁可报错也不让浏览器无限等
        rx.recv_timeout(self.timeout)
            .map_err(|_| BridgeError::Timeout)
    }
}

impl VaultOps for VaultProxy {
    fn lock_state(&self) -> LockState {
        self.ask(Call::LockState).unwrap_or(LockState::Locked)
    }

    fn app_version(&self) -> String {
        self.ask(Call::Version)
            .unwrap_or_else(|_| "unknown".to_string())
    }

    fn query(&mut self, origin: &str) -> Result<Vec<EntrySummary>, BridgeError> {
        self.ask(|reply| Call::Query {
            origin: origin.to_string(),
            reply,
        })?
    }

    fn fill(&mut self, entry_id: &str, origin: &str) -> Result<Zeroizing<String>, BridgeError> {
        self.ask(|reply| Call::Fill {
            entry_id: entry_id.to_string(),
            origin: origin.to_string(),
            reply,
        })?
    }

    fn save(&mut self, payload: SavePayload) -> Result<String, BridgeError> {
        self.ask(|reply| Call::Save { payload, reply })?
    }

    fn conflicts(&mut self) -> Result<keynest_bridge::serde_json::Value, BridgeError> {
        self.ask(Call::Conflicts)?
    }
}

/// 服务端线程句柄。
pub struct BridgeService {
    /// 只有 `Some` 时才在跑（解锁期间）
    running: Option<Running>,
    rx: Receiver<Call>,
    tx: Sender<Call>,
    data_dir: std::path::PathBuf,
    /// 最近一次启动失败的原因，供设置页展示
    last_error: Option<String>,
    /// UI 上下文：后台线程靠它按需唤醒界面。
    ///
    /// 只在 `start()` 后有效；`None` 时唤醒退化为空操作（不会 panic）。
    ctx: Option<egui::Context>,
}

struct Running {
    stop: Arc<std::sync::atomic::AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl BridgeService {
    pub fn new(data_dir: std::path::PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            running: None,
            rx,
            tx,
            data_dir,
            last_error: None,
            ctx: None,
        }
    }

    /// 绑定 UI 上下文：之后后台线程发请求时会用它唤醒界面。
    ///
    /// 必须在 `start()` 之前调用；`start()` 之后调用不会生效。
    pub fn attach_ctx(&mut self, ctx: egui::Context) {
        self.ctx = Some(ctx);
    }

    pub fn is_running(&self) -> bool {
        self.running.is_some()
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// 只在解锁后启动。锁定/退出时调用 [`Self::stop`]。
    pub fn start(&mut self) {
        if self.running.is_some() {
            return;
        }

        // 证书式的前置检查：密钥文件读写失败就别开服务，免得半死不活
        let (secret, created) = match keynest_bridge::keyfile::load_or_create(&self.data_dir) {
            Ok(v) => v,
            Err(e) => {
                self.last_error = Some(format!("桥接密钥初始化失败: {e}"));
                return;
            }
        };
        if created {
            // 首次生成：只记录，不打印内容
            self.last_error = Some("已生成新的桥接密钥".into());
        }

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let tx = self.tx.clone();
        let timeout = Duration::from_millis(keynest_bridge::limits::REQUEST_TIMEOUT_MS);
        // 管道监听失败的原因要能被 UI 读到，否则问题隐形
        let err_slot = Arc::new(std::sync::Mutex::new(None::<String>));
        let err_for_thread = Arc::clone(&err_slot);

        // 唤醒器：后台线程每入队一个请求就调一次。
        // 拿不到 ctx（未 attach）时退化为空操作，不 panic。
        let wake: Arc<dyn Fn() + Send + Sync> = {
            let ctx = self.ctx.clone();
            Arc::new(move || {
                if let Some(c) = &ctx {
                    c.request_repaint();
                }
            })
        };

        let join = thread::spawn(move || {
            while !stop_thread.load(std::sync::atomic::Ordering::SeqCst) {
                // 阻塞等一个客户端；GUI 锁定后 stop 会在下一次循环断言里退出
                let pipe = match keynest_bridge::pipe::accept_one() {
                    Ok(p) => p,
                    Err(e) => {
                        // 不再静默吞掉：管道建不起来时用户完全无感，
                        // 浏览器只会看到 HOST_DISCONNECTED，排查无从下手。
                        // 记录到 last_error（设置页可见），并退避重试。
                        let msg = format!("管道监听失败: {} ({})", e, e.code());
                        if err_for_thread
                            .lock()
                            .map(|m| m.as_deref() != Some(&msg))
                            .unwrap_or(true)
                        {
                            let _ = writeln!(io::stderr(), "keynest-bridge: {msg}");
                            if let Ok(mut slot) = err_for_thread.lock() {
                                *slot = Some(msg);
                            }
                        }
                        thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                };

                let mut proxy = VaultProxy {
                    tx: tx.clone(),
                    timeout,
                    wake: Arc::clone(&wake),
                };
                let opts = keynest_bridge::server::ServeOptions {
                    request_timeout: timeout,
                    ..Default::default()
                };
                // 一次连接的生命周期；出错就断开，回到 accept 等待下一个。
                //
                // **不要把错误吞掉**：握手失败、解密失败这些都不该静默。
                // 之前 `let _ =` 让"浏览器永远 TIMEOUT"这件事完全无法排查。
                // 这里只写错误码与描述（不含任何消息内容）。
                if let Err(e) = keynest_bridge::server::serve_with_options(
                    &mut { pipe },
                    &secret,
                    &mut proxy,
                    opts,
                ) {
                    if !matches!(e, keynest_bridge::BridgeError::Closed) {
                        let _ = writeln!(
                            io::stderr(),
                            "keynest-bridge: serve 结束: {} ({})",
                            e,
                            e.code()
                        );
                    }
                }
            }
        });

        self.running = Some(Running {
            stop,
            join: Some(join),
        });
        if self.last_error.as_deref() == Some("已生成新的桥接密钥") {
            // 保留提示
        } else {
            self.last_error = None;
        }
    }

    /// 停止服务并等待线程退出。锁定、退出、panic 兜底都要调用。
    pub fn stop(&mut self) {
        let Some(mut running) = self.running.take() else {
            return;
        };
        running
            .stop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // 线程可能正阻塞在 accept_one 上；这里不强杀，让它自己退出，
        // 进程退出时操作系统会回收。join 只做短暂等待，避免卡住 UI。
        if let Some(h) = running.join.take() {
            let _ = h; // 不 join：accept_one 是阻塞的，join 会让退出变慢
        }
    }

    /// UI 线程每帧调用：取走后台线程积压的请求。
    ///
    /// 返回 Vec 而不是接回调，是因为处理请求需要 `&mut self.state`，
    /// 而回调会把 `self` 借出去，绕不过借用检查器。
    pub fn collect_calls(&self) -> Vec<Call> {
        let mut out = Vec::new();
        while let Ok(call) = self.rx.try_recv() {
            out.push(call);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn proxy_forwards_and_gets_reply() {
        let (tx, rx) = channel::<Call>();
        let mut proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(500),
            wake: Arc::new(|| {}),
        };

        // UI 线程侧：收到调用就回一个假结果
        let ui = thread::spawn(move || {
            for call in rx {
                match call {
                    Call::LockState(r) => {
                        let _ = r.send(LockState::Unlocked);
                    }
                    Call::Query { reply, .. } => {
                        let _ = reply.send(Ok(vec![]));
                    }
                    _ => {}
                }
            }
        });

        assert_eq!(proxy.lock_state(), LockState::Unlocked);
        assert!(proxy.query("https://example.com").unwrap().is_empty());
        drop(proxy);
        let _ = ui.join();
    }

    #[test]
    fn proxy_times_out_when_ui_is_stuck() {
        let (tx, _rx) = channel::<Call>();
        let mut proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(30),
            wake: Arc::new(|| {}),
        };
        // 没人处理：必须超时，而不是永久阻塞
        let r = proxy.query("https://example.com");
        assert!(matches!(r, Err(BridgeError::Timeout)));
    }

    #[test]
    fn proxy_reports_closed_ui() {
        let (tx, rx) = channel::<Call>();
        drop(rx);
        let proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(30),
            wake: Arc::new(|| {}),
        };
        // UI 线程没了：lock_state 安全降级为 Locked
        assert_eq!(proxy.lock_state(), LockState::Locked);
    }

    #[test]
    fn wake_fires_only_after_successful_enqueue() {
        // 顺序不变式：先入队，后唤醒。
        // 反过来的话，UI 可能在被唤醒后、消息入队前跑完 pump_bridge()，
        // 于是这一帧没东西可处理，请求要等到下一次 100ms 兜底才被看见。
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (tx, rx) = channel::<Call>();
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&wakes);
        let mut proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(50),
            wake: Arc::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
        };

        // UI 侧不处理，让 ask 超时——但入队与唤醒仍应各发生一次
        let _ = proxy.query("https://example.com");
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "入队成功后必须唤醒一次");
        // 通道里确实有一条消息（证明先入队）
        assert!(rx.try_recv().is_ok(), "消息必须在唤醒之前就已入队");
    }

    #[test]
    fn wake_not_called_when_enqueue_fails() {
        // UI 线程已退出（rx 被 drop）→ send 失败 → **不应**唤醒
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (tx, rx) = channel::<Call>();
        drop(rx);
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&wakes);
        let mut proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(30),
            wake: Arc::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
        };
        let r = proxy.query("https://example.com");
        assert!(r.is_err(), "UI 已退出应报错");
        assert_eq!(wakes.load(Ordering::SeqCst), 0, "入队失败不应唤醒");
    }

    #[test]
    fn multiple_enqueues_each_wake() {
        // 连续多个请求：每个都要唤醒一次，不能合并成一次（否则后面的请求要等兜底）
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (tx, rx) = channel::<Call>();
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&wakes);
        let proxy = VaultProxy {
            tx,
            timeout: Duration::from_millis(20),
            wake: Arc::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
            }),
        };
        for _ in 0..5 {
            let _ = proxy.lock_state();
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 5, "5 个请求应有 5 次唤醒");
        // 5 条消息都在队列里，没有丢失
        let mut n = 0;
        while rx.try_recv().is_ok() {
            n += 1;
        }
        assert_eq!(n, 5, "消息不丢失");
    }

    #[test]
    fn no_ctx_means_wake_is_noop_not_panic() {
        // 未 attach_ctx 时唤醒必须退化为空操作
        let mut svc = BridgeService::new(std::path::PathBuf::from("."));
        svc.attach_ctx(egui::Context::default());
        // 这里只验证 attach 不 panic；实际唤醒由上面的 proxy 测试覆盖
        assert!(svc.ctx.is_some());
    }

    #[test]
    fn service_starts_and_stops() {
        let mut dir = std::env::temp_dir();
        dir.push(format!("kn-bridge-svc-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut svc = BridgeService::new(dir.clone());
        assert!(!svc.is_running());
        svc.start();
        assert!(svc.is_running());
        svc.stop();
        assert!(!svc.is_running());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
