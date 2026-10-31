//! 命令返回值构造。与 Node 版 `ok()` / `fail()` 的 JSON 形状一致。

use serde::Serialize;
use serde_json::Value;

pub fn ok<T: Serialize>(data: T) -> Value {
    serde_json::json!({ "ok": true, "data": data })
}

pub fn err(code: &str, message: &str) -> Value {
    serde_json::json!({ "ok": false, "error": { "code": code, "message": message } })
}
