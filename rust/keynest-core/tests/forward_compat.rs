//! 前向兼容性验证。
//!
//! 这些测试回答一个具体问题：**如果把新字段写进密码库，v0.4.3 之前的程序
//! 读入后再次保存，新字段会不会丢？**
//!
//! 这里的「旧程序」用当前 `Entry` 类型模拟——因为 `Entry` 没有
//! `deny_unknown_fields`，也没有 `#[serde(flatten)]` 兜底，未知字段在
//! 反序列化阶段就被丢弃了。所以「旧程序存盘 = 用旧结构重新序列化」，
//! 结论对任何假设中的新字段都成立。

use keynest_core::{Entry, VaultData};

fn entry_json_with_extra_field() -> &'static str {
    r#"{
        "id": "e1",
        "title": "示例",
        "username": "u",
        "password": "p",
        "url": "https://example.com",
        "category": "网站",
        "notes": "",
        "favorite": false,
        "kind": "账号",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "rev": 7
    }"#
}

#[test]
fn unknown_entry_fields_are_silently_dropped_on_roundtrip() {
    let e: Entry = serde_json::from_str(entry_json_with_extra_field()).unwrap();
    let back = serde_json::to_string(&e).unwrap();

    assert!(
        !back.contains("\"rev\""),
        "旧结构重新序列化后不应保留未知字段，实际输出: {back}"
    );
    // 原有字段必须完好——丢的只是「它不认识的那个」
    assert!(back.contains("\"title\":\"示例\""));
    assert!(back.contains("\"password\":\"p\""));
}

#[test]
fn unknown_vault_level_fields_are_dropped_too() {
    // 库顶层同理：给 VaultData 加字段，旧程序保存时同样会丢。
    let json = r#"{
        "version": 3,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "settings": {
            "autoLockMinutes": 5,
            "clipboardClearSeconds": 30,
            "revealSeconds": 10,
            "importPrompted": false
        },
        "categories": ["网站"],
        "types": ["账号"],
        "entries": [],
        "browserSync": { "deviceId": "abc" }
    }"#;
    let data: VaultData = serde_json::from_str(json).unwrap();
    let back = serde_json::to_string(&data).unwrap();
    assert!(!back.contains("browserSync"), "库顶层未知字段同样会被丢弃");
}
