//! 原生标题栏的外观同步。
//!
//! 目标：窗口标题栏不要出现「浅色界面 + 深色标题栏」的割裂。
//!
//! 优先级：
//! 1. Win11 的 `DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR`（属性 35/36）——直接着色；
//! 2. 老系统的 `DWMWA_USE_IMMERSIVE_DARK_MODE`（属社 19/20）——只能切明暗。
//!
//! 只调用系统自带的 `dwmapi.dll`，不引入第三方库；失败一律忽略。

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use super::theme;

thread_local! {
    static HWND: std::cell::RefCell<isize> = const { std::cell::RefCell::new(0) };
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        pub fn DwmSetWindowAttribute(
            hwnd: isize,
            attr: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
    }
}

/// 把 sRGB 转成 Windows 的 COLORREF（0x00BBGGRR）。
#[cfg(windows)]
fn colorref(c: egui::Color32) -> u32 {
    ((c.b() as u32) << 16) | ((c.g() as u32) << 8) | (c.r() as u32)
}

/// 每帧调用一次：缓存窗口句柄。
pub fn remember_window(frame: &eframe::Frame) {
    if HWND.with(|h| *h.borrow()) != 0 {
        return;
    }
    if let Ok(handle) = frame.window_handle() {
        if let RawWindowHandle::Win32(win) = handle.as_raw() {
            HWND.with(|h| *h.borrow_mut() = win.hwnd.get());
        }
    }
}

/// 按当前配色重新着色标题栏。
#[cfg(windows)]
pub fn sync_titlebar() {
    use std::ffi::c_void;

    let hwnd = HWND.with(|h| *h.borrow());
    if hwnd == 0 {
        return;
    }

    let p = theme::palette();
    let dark = theme::is_dark();

    // 1) 明暗模式（让标题栏按钮正反色正确）
    let mode: i32 = if dark { 1 } else { 0 };
    unsafe {
        for attr in [20u32, 19u32] {
            let _ = sys::DwmSetWindowAttribute(hwnd, attr, &mode as *const i32 as *const c_void, 4);
        }
    }

    // 2) 标题栏底色 / 文字色 / 边框色（Win11 22000+）
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    unsafe {
        for (attr, color) in [
            (DWMWA_CAPTION_COLOR, p.surface),
            (DWMWA_TEXT_COLOR, p.text),
            (DWMWA_BORDER_COLOR, p.border),
        ] {
            let v = colorref(color);
            let _ = sys::DwmSetWindowAttribute(hwnd, attr, &v as *const u32 as *const c_void, 4);
        }
    }
}

#[cfg(not(windows))]
pub fn sync_titlebar() {}
