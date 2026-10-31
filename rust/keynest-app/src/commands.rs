//! Tauri IPC 命令。对应 Electron 版 `main.js` 里的 `handle('vault:xxx')`。

use crate::AppState;
use keynest_core::vault::Entry;
use keynest_core::{password, Vault};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

type Ctx<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
struct Status {
    exists: bool,
    unlocked: bool,
    path: String,
}

use crate::helpers::{ok, err};

/* ---------------- 仓库状态 ---------------- */

#[tauri::command]
pub fn vault_status(state: Ctx) -> Value {
    let vault = state.vault.lock();
    ok(Status {
        exists: vault.exists(),
        unlocked: vault.is_unlocked(),
        path: state.vault_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn vault_touch(state: Ctx) -> Value {
    state.touch();
    ok(true)
}

#[tauri::command]
pub fn vault_create(state: Ctx, password: String) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    match vault.create(&password) {
        Ok(data) => ok(serde_json::to_value(data).unwrap_or(Value::Null)),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

#[tauri::command]
pub fn vault_unlock(state: Ctx, password: String) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    match vault.unlock(&password) {
        Ok(data) => ok(serde_json::to_value(data).unwrap_or(Value::Null)),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

#[tauri::command]
pub fn vault_lock(state: Ctx) -> Value {
    state.vault.lock().lock();
    ok(true)
}

#[tauri::command]
pub fn vault_snapshot(state: Ctx) -> Value {
    let vault = state.vault.lock();
    match vault.snapshot() {
        Ok(data) => ok(serde_json::to_value(data).unwrap_or(Value::Null)),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

/* ---------------- 条目 ---------------- */

#[derive(Deserialize)]
pub struct SaveEntryArgs {
    pub entry: EntryInput,
}

#[derive(Deserialize)]
pub struct EntryInput {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub notes: String,
}

#[tauri::command]
pub fn vault_save_entry(state: Ctx, entry: EntryInput) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    let result = vault.upsert_entry(Entry {
        id: entry.id,
        title: entry.title,
        username: entry.username,
        password: entry.password,
        url: entry.url,
        category: if entry.category.is_empty() { "其他".into() } else { entry.category },
        notes: entry.notes,
        created_at: String::new(),
        updated_at: String::new(),
    });

    match result {
        Ok(saved) => ok(serde_json::to_value(saved).unwrap_or(Value::Null)),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

#[tauri::command]
pub fn vault_delete_entry(state: Ctx, id: String) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    match vault.delete_entry(&id) {
        Ok(()) => ok(true),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

#[tauri::command]
pub fn vault_add_category(state: Ctx, name: String) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    let mut data = match vault.snapshot() {
        Ok(d) => d,
        Err(e) => return err(e.code(), &e.to_string()),
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return err("INVALID_CATEGORY", "分类名不能为空");
    }
    if !data.categories.iter().any(|c| c == trimmed) {
        data.categories.push(trimmed.to_string());
        // 通过一次 save 落盘
        let _ = vault.save();
    }
    ok(trimmed)
}

#[derive(Deserialize)]
pub struct SettingsPatch {
    #[serde(rename = "autoLockMinutes")]
    pub auto_lock_minutes: Option<u32>,
    #[serde(rename = "clipboardClearSeconds")]
    pub clipboard_clear_seconds: Option<u32>,
    #[serde(rename = "revealSeconds")]
    pub reveal_seconds: Option<u32>,
    #[serde(rename = "importPrompted")]
    pub import_prompted: Option<bool>,
}

#[tauri::command]
pub fn vault_update_settings(state: Ctx, patch: SettingsPatch) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    let mut data = match vault.snapshot() {
        Ok(d) => d,
        Err(e) => return err(e.code(), &e.to_string()),
    };

    if let Some(v) = patch.auto_lock_minutes {
        data.settings.auto_lock_minutes = v.clamp(1, 240);
    }
    if let Some(v) = patch.clipboard_clear_seconds {
        data.settings.clipboard_clear_seconds = v.min(300);
    }
    if let Some(v) = patch.reveal_seconds {
        data.settings.reveal_seconds = v.min(300);
    }
    if let Some(v) = patch.import_prompted {
        data.settings.import_prompted = v;
    }

    // 写回 data 再 save
    vault.replace_data(data.clone());
    if let Err(e) = vault.save() {
        return err(e.code(), &e.to_string());
    }
    ok(serde_json::to_value(data.settings).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn vault_change_master(state: Ctx, old_password: String, new_password: String) -> Value {
    state.touch();
    let mut vault = state.vault.lock();
    match vault.change_master(&old_password, &new_password) {
        Ok(()) => ok(true),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

#[tauri::command]
pub fn vault_wipe(state: Ctx) -> Value {
    let mut vault = state.vault.lock();
    match vault.wipe() {
        Ok(()) => ok(true),
        Err(e) => err(e.code(), &e.to_string()),
    }
}

/* ---------------- 密码工具 ---------------- */

#[derive(Deserialize, Default)]
pub struct GenArgs {
    #[serde(default = "d_len")]
    pub length: usize,
    #[serde(default = "d_true")]
    pub lowercase: bool,
    #[serde(default = "d_true")]
    pub uppercase: bool,
    #[serde(default = "d_true")]
    pub digits: bool,
    #[serde(default = "d_true")]
    pub symbols: bool,
    #[serde(default = "d_true", rename = "excludeAmbiguous")]
    pub exclude_ambiguous: bool,
}

fn d_len() -> usize { 16 }
fn d_true() -> bool { true }

#[tauri::command]
pub fn generate_password(args: Option<GenArgs>) -> Value {
    let a = args.unwrap_or_default();
    let opts = password::GenOptions {
        length: a.length.clamp(4, 64),
        lowercase: a.lowercase,
        uppercase: a.uppercase,
        digits: a.digits,
        symbols: a.symbols,
        exclude_ambiguous: a.exclude_ambiguous,
    };
    ok(password::generate(&opts))
}

#[tauri::command]
pub fn estimate_strength(password: String) -> Value {
    ok(password::estimate_strength(&password))
}

/* ---------------- 导出 ---------------- */

#[tauri::command]
pub fn vault_export_plain(state: Ctx, format: String) -> Value {
    state.touch();
    let vault = state.vault.lock();
    let data = match vault.snapshot() {
        Ok(d) => d,
        Err(e) => return err(e.code(), &e.to_string()),
    };
    if data.entries.is_empty() {
        return err("VAULT_EMPTY", "仓库里还没有条目");
    }

    let content = if format == "json" {
        crate::browser::export::to_json(&data)
    } else {
        crate::browser::export::to_csv(&data.entries)
    };

    ok(serde_json::json!({
        "format": if format == "json" { "json" } else { "csv" },
        "content": content,
        "count": data.entries.len(),
    }))
}
