//! 应用状态：仓库实例 + 自动锁定计时。

use keynest_core::Vault;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
    pub vault: Mutex<Vault>,
    pub vault_path: PathBuf,
    last_activity: AtomicI64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl AppState {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault: Mutex::new(Vault::new(&vault_path)),
            vault_path,
            last_activity: AtomicI64::new(now_ms()),
        }
    }

    pub fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }

    /// 检查是否该自动锁定。由后台线程每 5 秒调用。
    pub fn check_auto_lock(&self, app: &AppHandle) {
        let vault = self.vault.lock();
        if !vault.is_unlocked() {
            return;
        }
        let minutes = vault
            .snapshot()
            .map(|d| d.settings.auto_lock_minutes)
            .unwrap_or(5) as i64;

        let idle = now_ms() - self.last_activity.load(Ordering::Relaxed);
        if idle >= minutes * 60 * 1000 {
            drop(vault);
            self.vault.lock().lock();
            // 通知前端回到锁屏
            let _ = app.emit("vault:locked", serde_json::json!({ "reason": "idle" }));
        }
    }
}
