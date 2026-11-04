//! 钥巢 — 纯 Rust egui 桌面端。
//!
//! 不依赖 Tauri / WebView / JS 运行时；加密与剪贴板全部由 `keynest-core` 提供。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keynest_egui::app;

/// 窗口图标（任务栏与 Alt+Tab 里显示的那个）。
///
/// # 为什么必须显式设置
///
/// Windows 在任务栏上取图标的优先级是：
///
/// 1. **窗口图标**（运行时由程序设置）
/// 2. exe 内嵌资源图标（`build.rs` 那一套）
/// 3. 系统默认图标
///
/// 之前 `build.rs` 已经把图标嵌进 exe 了，桌面与资源管理器显示正常——
/// 但任务栏显示的是 **eframe/winit 的默认图标**（一个白色风车），
/// 因为第 1 优先级是空的，Windows 就用框架给的默认值，
/// 根本走不到第 2 优先级。
///
/// 嵌进二进制（`include_bytes!`）而不是运行时读文件：
/// 单文件分发时旁边不会有 `icon.png`。
fn window_icon() -> Option<egui::IconData> {
    let bytes = include_bytes!("../../../build/icon.png");
    let img = image::load_from_memory(bytes).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Some(egui::IconData {
        rgba: img.into_raw(),
        width: w,
        height: h,
    })
}

fn main() -> eframe::Result<()> {
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([1180.0, 760.0])
        .with_min_inner_size([1024.0, 620.0])
        .with_title("钥巢");

    if let Some(icon) = window_icon() {
        viewport = viewport.with_icon(std::sync::Arc::new(icon));
    }

    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "钥巢",
        options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}
