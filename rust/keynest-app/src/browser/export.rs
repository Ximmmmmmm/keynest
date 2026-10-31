//! 明文导出。与 Node 版 `src/main/export.js` 格式一致。

use keynest_core::vault::{Entry, VaultData};

pub const CSV_COLUMNS: [&str; 5] = ["name", "url", "username", "password", "note"];

/// CSV 字段转义：含逗号、引号、换行时加引号，内部引号翻倍。
pub fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 导出为 CSV。列顺序与 Chrome / Edge / Firefox 一致，可直接回灌浏览器。
pub fn to_csv(entries: &[Entry]) -> String {
    let mut out = String::new();
    out.push_str(&CSV_COLUMNS.join(","));
    out.push_str("\r\n");

    for e in entries {
        let cells = [
            csv_cell(&e.title),
            csv_cell(&e.url),
            csv_cell(&e.username),
            csv_cell(&e.password),
            csv_cell(&e.notes),
        ];
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    out
}

/// 导出为 JSON，保留完整字段便于无损迁移。
pub fn to_json(data: &VaultData) -> String {
    let payload = serde_json::json!({
        "format": "keynest.export.v1",
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "count": data.entries.len(),
        "categories": data.categories,
        "entries": data.entries,
    });
    serde_json::to_string_pretty(&payload).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str, pwd: &str) -> Entry {
        Entry {
            id: String::new(),
            title: title.into(),
            username: "u".into(),
            password: pwd.into(),
            url: "https://x.test".into(),
            category: "网站".into(),
            notes: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn plain_cell_not_quoted() {
        assert_eq!(csv_cell("abc"), "abc");
    }

    #[test]
    fn comma_forces_quoting() {
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
    }

    #[test]
    fn quotes_are_doubled() {
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn header_matches_chrome() {
        let csv = to_csv(&[]);
        assert_eq!(csv.lines().next().unwrap(), "name,url,username,password,note");
    }

    #[test]
    fn csv_roundtrip_preserves_password() {
        let entries = vec![entry("Tricky", "p,a\"s\ns")];
        let csv = to_csv(&entries);
        let (parsed, _) = crate::browser::csv::items_from_csv(&csv).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].password, "p,a\"s\ns");
    }

    #[test]
    fn json_has_format_marker() {
        let mut d = VaultData::default();
        d.entries.push(entry("A", "p"));
        let json: serde_json::Value = serde_json::from_str(&to_json(&d)).unwrap();
        assert_eq!(json["format"], "keynest.export.v1");
        assert_eq!(json["count"], 1);
    }
}
