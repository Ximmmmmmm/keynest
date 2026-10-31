//! 钥巢 Tauri 应用：窗口、IPC 命令、自动锁定、剪贴板。
//!
//! 前端 `src/renderer/` 完全复用，只把 `preload.js` 的 IPC 调用换成 Tauri 的 invoke。

mod browser;
mod commands;
mod helpers;
mod state;

use std::sync::Arc;
use tauri::Manager;

pub use state::AppState;

fn main() {
    let data_dir = std::env::var("KEYNEST_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(base).join("KeyNest")
        });

    std::fs::create_dir_all(&data_dir).ok();
    let vault_path = data_dir.join("vault.dat");

    let state = Arc::new(AppState::new(vault_path));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            // 仓库
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_snapshot,
            commands::vault_save_entry,
            commands::vault_delete_entry,
            commands::vault_add_category,
            commands::vault_update_settings,
            commands::vault_change_master,
            commands::vault_wipe,
            commands::vault_touch,
            // 密码工具
            commands::generate_password,
            commands::estimate_strength,
            // 导入
            browser::commands::browser_scan,
            browser::commands::browser_discover_csv,
            browser::commands::browser_import_files,
            browser::commands::browser_discard_csv,
            // 导出
            commands::vault_export_plain,
        ])
        .setup(|app| {
            // 自动锁定定时器
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let state = handle.state::<Arc<AppState>>();
                state.check_auto_lock(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
