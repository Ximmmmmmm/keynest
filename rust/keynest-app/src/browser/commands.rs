//! 浏览器导入相关命令。

use crate::browser::{csv, discovery, export, login_data};
use crate::helpers::{ok, err};
use crate::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

type Ctx<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub fn browser_scan() -> Value {
    let sources = login_data::scan();
    ok(serde_json::json!({ "sources": sources }))
}

#[tauri::command]
pub fn browser_discover_csv() -> Value {
    let dirs = discovery::default_dirs();
    let d = discovery::discover(&dirs);

    let files: Vec<Value> = d
        .files
        .iter()
        .map(|f| {
            serde_json::json!({
                "path": f.path.to_string_lossy(),
                "name": f.name,
                "size": f.size,
                "ageLabel": f.age_label(),
                "ageMs": f.age.as_millis() as u64,
            })
        })
        .collect();

    ok(serde_json::json!({
        "found": d.found,
        "confident": d.confident,
        "truncated": d.truncated,
        "files": files,
        "candidates": files,
        "file": files.first(),
        "scannedDirs": dirs.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn browser_import_files(state: Ctx, file_paths: Vec<String>, mode: String) -> Value {
    state.touch();
    let overwrite = mode == "overwrite";

    let mut merged = Vec::new();
    let mut per_file = Vec::new();
    let mut total_skipped = 0usize;

    for p in &file_paths {
        match std::fs::read_to_string(p) {
            Ok(text) => match csv::items_from_csv(&text) {
                Ok((items, skipped)) => {
                    total_skipped += skipped;
                    per_file.push(serde_json::json!({
                        "path": p,
                        "name": std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        "count": items.len(),
                        "error": Value::Null,
                    }));
                    merged.extend(items);
                }
                Err(e) => per_file.push(serde_json::json!({
                    "path": p,
                    "name": std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    "count": 0,
                    "error": e,
                })),
            },
            Err(e) => per_file.push(serde_json::json!({
                "path": p,
                "name": std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "count": 0,
                "error": e.to_string(),
            })),
        }
    }

    if merged.is_empty() {
        return err("CSV_EMPTY", "这些 CSV 里都没有可导入的账号");
    }

    let mut vault = state.vault.lock();
    let data = match vault.snapshot() {
        Ok(d) => d,
        Err(e) => return err(e.code(), &e.to_string()),
    };

    let plan = csv::plan_import(&data.entries, merged, overwrite);
    let mut added = 0usize;
    let mut updated = 0usize;

    for item in plan.add {
        if vault.upsert_entry(item).is_ok() {
            added += 1;
        }
    }
    for (id, new_pwd) in plan.update {
        if let Ok(mut data) = vault.snapshot() {
            if let Some(target) = data.entries.iter_mut().find(|e| e.id == id) {
                target.password = new_pwd;
                updated += 1;
            }
        }
    }

    let total = added + updated + plan.skipped;
    ok(serde_json::json!({
        "stats": {
            "added": added,
            "updated": updated,
            "skipped": plan.skipped,
            "invalid": plan.invalid,
            "failed": plan.invalid,
            "appBound": 0,
            "total": total,
            "skippedRows": total_skipped,
        },
        "fileCount": per_file.len(),
        "perFile": per_file,
        "fileName": if per_file.len() == 1 { per_file[0]["name"].clone() } else { serde_json::json!(format!("{} 个文件", per_file.len())) },
        "filePaths": file_paths,
    }))
}

#[tauri::command]
pub fn browser_discard_csv(file_paths: Vec<String>) -> Value {
    let mut removed = 0usize;
    for p in &file_paths {
        if std::fs::remove_file(p).is_ok() {
            removed += 1;
        }
    }
    ok(serde_json::json!({
        "removed": removed,
        "total": file_paths.len(),
        "path": file_paths.first(),
    }))
}
