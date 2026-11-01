//! 钥巢 — 纯 Rust egui 桌面端。
//!
//! 不依赖 Tauri / WebView / JS 运行时；加密与剪贴板全部由 `keynest-core` 提供。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keynest_egui::app;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1180.0, 760.0])
            .with_min_inner_size([1024.0, 620.0])
            .with_title("钥巢"),
        ..Default::default()
    };

    eframe::run_native(
        "钥巢",
        options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}
