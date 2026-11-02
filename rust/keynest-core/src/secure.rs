//! 敏感操作：剪贴板与系统级闲置检测。
//!
//! 这个模块**不含任何 UI / WebView**，只调用 Win32 API。
//!
//! 对应审查清单第 7、8 条：
//! * 复制密码后按 TTL 自动清除；
//! * 清除前先读回剪贴板，确认内容仍是自己写入的那一份（否则说明用户
//!   已经复制了别的东西，不能误删）；
//! * 写入时把内容标记为「不进剪贴板历史、不上传云剪贴板」；
//! * 自动锁定改用 `GetLastInputInfo` 的系统级闲置，而不是前端心跳。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use zeroize::Zeroizing;

use crate::error::{Result, VaultError};

/// 默认剪贴板存活时间。
pub const DEFAULT_CLIPBOARD_TTL: Duration = Duration::from_secs(20);

/// 每次复制的代数。用于「旧定时器不要清掉新内容」。
static COPY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 最近一次「自动清除剪贴板」失败的时间与原因。
///
/// 为什么需要它：清除失败时密码仍留在剪贴板里，而用户以为已经清掉了。
/// 原来那处是 `let _ = clear_if_matches(...)`，失败被完全吞掉——
/// 这是安全属性上的静默失效，比普通的功能失败严重得多。
static LAST_CLEAR_FAILURE: Mutex<Option<(std::time::Instant, String)>> = Mutex::new(None);

fn record_clear_failure(reason: &str) {
    if let Ok(mut slot) = LAST_CLEAR_FAILURE.lock() {
        *slot = Some((std::time::Instant::now(), reason.to_string()));
    }
}

/// 取最近一次清除失败（若有）。
///
/// 界面据此提示用户「请手动清空剪贴板」。取用后不清除记录——
/// 用户可能需要反复看到提示，直到他手动复制了别的内容。
pub fn last_clear_failure() -> Option<String> {
    LAST_CLEAR_FAILURE
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|(_, r)| r.clone()))
}

/// 清除成功后调用，抹掉失败记录。
fn clear_failure_record() {
    if let Ok(mut slot) = LAST_CLEAR_FAILURE.lock() {
        *slot = None;
    }
}

/* ================================================================== */
/* Windows 实现                                                        */
/* ================================================================== */

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    /// CF_UNICODETEXT 的数值。直接写常量，避免依赖不同 feature 的导入路径。
    const CF_UNICODETEXT: u32 = 13;
    /// 读取剪贴板文本时的上限，防止异常数据导致超大分配。
    const MAX_CLIPBOARD_CHARS: usize = 32768;

    /// 打开剪贴板并保证关闭。剪贴板是全局独占资源，可能被别的进程占着，
    /// 所以带重试。
    struct ClipboardGuard;

    impl ClipboardGuard {
        fn open() -> Result<Self> {
            for _ in 0..10 {
                unsafe {
                    if OpenClipboard(None).is_ok() {
                        return Ok(ClipboardGuard);
                    }
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(VaultError::Clipboard("无法打开剪贴板"))
        }
    }

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    unsafe fn set_dword_format(fmt: u32, value: u32) -> bool {
        let h: HGLOBAL = match GlobalAlloc(GMEM_MOVEABLE, 4) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let p = GlobalLock(h);
        if p.is_null() {
            return false;
        }
        std::ptr::copy_nonoverlapping(value.to_le_bytes().as_ptr(), p as *mut u8, 4);
        let _ = GlobalUnlock(h);
        SetClipboardData(fmt, HANDLE(h.0)).is_ok()
    }

    unsafe fn set_text(text: &str) -> bool {
        // UTF-16 + 结尾 NUL
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0u16)).collect();
        let bytes = wide.len() * 2;

        let h: HGLOBAL = match GlobalAlloc(GMEM_MOVEABLE, bytes) {
            Ok(h) => h,
            Err(_) => return false,
        };
        let p = GlobalLock(h);
        if p.is_null() {
            return false;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, p as *mut u8, bytes);
        let _ = GlobalUnlock(h);

        // SetClipboardData 成功后内存归系统所有，不要自己释放
        SetClipboardData(CF_UNICODETEXT, HANDLE(h.0)).is_ok()
    }

    unsafe fn get_text() -> Option<String> {
        let h = GetClipboardData(CF_UNICODETEXT).ok()?;
        if h.is_invalid() {
            return None;
        }
        let p = GlobalLock(HGLOBAL(h.0));
        if p.is_null() {
            return None;
        }

        // 手动找 NUL 结尾，限制最大扫描长度
        let mut len = 0usize;
        while len < MAX_CLIPBOARD_CHARS {
            let unit = *(p as *const u16).add(len);
            if unit == 0 {
                break;
            }
            len += 1;
        }
        let slice = std::slice::from_raw_parts(p as *const u16, len);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(HGLOBAL(h.0));
        Some(text)
    }

    /// 写入敏感文本，并打上「不进历史 / 不上云」标记。
    pub fn copy_sensitive_text(text: &str) -> Result<()> {
        let _guard = ClipboardGuard::open()?;

        unsafe {
            if EmptyClipboard().is_err() {
                return Err(VaultError::Clipboard("清空剪贴板失败"));
            }

            // 这三项是 Windows 10+ 认可的剪贴板控制格式：
            //   CanIncludeInClipboardHistory=0        → 不进 Win+V 历史
            //   CanUploadToCloudClipboard=0           → 不同步到云剪贴板
            //   ExcludeClipboardContentFromMonitorProcessing（空数据）→ 排除监控
            let f_hist = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
            let f_cloud = RegisterClipboardFormatW(w!("CanUploadToCloudClipboard"));
            let f_excl =
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));

            if f_hist != 0 {
                set_dword_format(f_hist, 0);
            }
            if f_cloud != 0 {
                set_dword_format(f_cloud, 0);
            }
            if f_excl != 0 {
                // 该格式要求「登记 + 无数据」。传空句柄时 Win32 返回 NULL，
                // windows-rs 会把它包装成 Err；调用本身已经生效，忽略返回值。
                let _ = SetClipboardData(f_excl, HANDLE(std::ptr::null_mut()));
            }

            if !set_text(text) {
                return Err(VaultError::Clipboard("写入剪贴板失败"));
            }
        }

        Ok(())
    }

    /// 仅当剪贴板内容仍是 `expected` 时才清空。
    pub fn clear_if_matches(expected: &str) -> Result<bool> {
        let _guard = ClipboardGuard::open()?;
        unsafe {
            let current = get_text();
            match current {
                Some(t) if t == expected => {
                    // 匹配：清掉
                    if EmptyClipboard().is_ok() {
                        Ok(true)
                    } else {
                        Err(VaultError::Clipboard("清空剪贴板失败"))
                    }
                }
                // 用户已经复制了别的内容，不要动它
                _ => Ok(false),
            }
        }
    }

    /// 读取当前剪贴板文本（只用于校验/诊断）。
    pub fn read_text() -> Option<String> {
        let _guard = ClipboardGuard::open().ok()?;
        unsafe { get_text() }
    }

    /// 系统级闲置时长（最后一次键鼠输入至今）。
    pub fn system_idle() -> Duration {
        unsafe {
            let mut info = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if !GetLastInputInfo(&mut info).as_bool() {
                return Duration::ZERO;
            }
            // GetTickCount 是 32 位毫秒计数，会回绕；用 wrapping_sub 处理
            let now = GetTickCount();
            let elapsed_ms = now.wrapping_sub(info.dwTime);
            Duration::from_millis(elapsed_ms as u64)
        }
    }
}

/* ================================================================== */
/* 非 Windows：明确报「不支持」，不静默降级                              */
/* ================================================================== */

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn copy_sensitive_text(_text: &str) -> Result<()> {
        Err(VaultError::Clipboard("当前平台不支持安全剪贴板"))
    }

    pub fn clear_if_matches(_expected: &str) -> Result<bool> {
        Err(VaultError::Clipboard("当前平台不支持安全剪贴板"))
    }

    pub fn read_text() -> Option<String> {
        None
    }

    pub fn system_idle() -> Duration {
        Duration::ZERO
    }
}

/* ================================================================== */
/* 对外接口                                                            */
/* ================================================================== */

/// 复制敏感文本，并在 `ttl` 后自动清除。
///
/// 语义保证：
/// 1. 立即写入剪贴板，且标记为不进入历史/云同步；
/// 2. `ttl` 到期后，**仅当内容仍是本次写入的文本**时才清空；
/// 3. 若期间又复制了别的内容，定时器什么都不做；
/// 4. 若期间又调用了一次本函数，旧定时器会让位给新的一次；
/// 5. **清除失败会被记录**，界面可以提示用户手动清空
///    （原来这里失败是静默的，密码会一直留在剪贴板里）。
pub fn copy_sensitive(text: &str, ttl: Option<Duration>) -> Result<()> {
    let ttl = ttl.unwrap_or(DEFAULT_CLIPBOARD_TTL);
    imp::copy_sensitive_text(text)?;

    let generation = COPY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // 期望值单独持有一份并会被清零，避免定时器线程里长期留明文
    let expected = Zeroizing::new(text.to_string());

    std::thread::spawn(move || {
        std::thread::sleep(ttl);
        // 已有更新的复制发生 → 不处理
        if COPY_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }

        // 清除失败必须留痕：密码还在剪贴板里，而用户以为已经没了。
        // 失败时重试一次——Windows 上剪贴板被别的程序短暂占用是常见情况，
        // 隔一下再试通常就好了。
        match imp::clear_if_matches(expected.as_str()) {
            Ok(_) => clear_failure_record(),
            Err(e) => {
                std::thread::sleep(Duration::from_millis(300));
                match imp::clear_if_matches(expected.as_str()) {
                    Ok(_) => clear_failure_record(),
                    Err(_) => record_clear_failure(&e.to_string()),
                }
            }
        }
    });

    Ok(())
}

/// 手动清除（例如锁定时立即清理）。
pub fn clear_now(expected: &str) -> Result<bool> {
    // 先让所有在途定时器失效
    COPY_GENERATION.fetch_add(1, Ordering::SeqCst);
    imp::clear_if_matches(expected)
}

/// 读取当前剪贴板文本。
///
/// 仅用于「清除前校验」与诊断。调用方不应该把它用于任何其他目的。
pub fn clipboard_text() -> Option<String> {
    imp::read_text()
}

/// 系统级闲置时长。自动锁定应基于这个值，而不是应用内的心跳。
pub fn system_idle() -> Duration {
    imp::system_idle()
}

/// 是否已超过闲置阈值。
pub fn is_idle_beyond(minutes: u32) -> bool {
    let threshold = Duration::from_secs(minutes as u64 * 60);
    system_idle() >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_threshold_is_sane() {
        // 0 分钟阈值必定判定为闲置
        assert!(is_idle_beyond(0));
    }

    #[test]
    fn very_long_threshold_not_idle() {
        // 100000 分钟 ≈ 69 天，正常不会闲置这么久
        assert!(!is_idle_beyond(100_000));
    }
}
