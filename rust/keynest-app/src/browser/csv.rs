//! CSV 解析。与 Node 版 `browser-import.js` 的 `parseCsv` / `itemsFromCsv` 行为一致。

use keynest_core::vault::Entry;

/// 解析 CSV（支持引号、转义引号、CRLF、引号内换行）。
pub fn parse_csv(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }

        match ch {
            '"' => quoted = true,
            c if c == delimiter => {
                row.push(std::mem::take(&mut field));
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\r' => { /* 兼容 CRLF */ }
            _ => field.push(ch),
        }
    }

    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }

    rows
}

const URL_KEYS: [&str; 5] = ["url", "origin", "website", "login_uri", "web site"];
const USER_KEYS: [&str; 4] = ["username", "login", "user", "login_username"];
const PASS_KEYS: [&str; 3] = ["password", "pass", "login_password"];
const NAME_KEYS: [&str; 2] = ["name", "title"];

fn find_col(header: &[String], keys: &[&str]) -> Option<usize> {
    header
        .iter()
        .position(|cell| keys.contains(&cell.trim().to_lowercase().as_str()))
}

/// 从 CSV 文本提取条目。返回 (条目列表, 跳过的行数)。
pub fn items_from_csv(source: &str) -> Result<(Vec<Entry>, usize), String> {
    let text = source.trim_start_matches('\u{feff}');
    let first_line = text.lines().next().unwrap_or("");
    // 分号比逗号多时用分号（部分欧洲 locale 的 Excel 导出）
    let delimiter = if first_line.matches(';').count() > first_line.matches(',').count() {
        ';'
    } else {
        ','
    };

    let rows: Vec<Vec<String>> = parse_csv(text, delimiter)
        .into_iter()
        .filter(|cells| cells.iter().any(|c| !c.trim().is_empty()))
        .collect();

    if rows.is_empty() {
        return Ok((Vec::new(), 0));
    }

    let header: Vec<String> = rows[0].iter().map(|c| c.trim().to_lowercase()).collect();
    let i_url = find_col(&header, &URL_KEYS);
    let i_user = find_col(&header, &USER_KEYS);
    let i_pass = find_col(&header, &PASS_KEYS);
    let i_name = find_col(&header, &NAME_KEYS);

    if i_pass.is_none() {
        return Err("CSV 中找不到 password 列".into());
    }

    let mut items = Vec::new();
    let mut skipped = 0usize;

    for row in rows.iter().skip(1) {
        let cell = |idx: Option<usize>| -> String {
            idx.and_then(|i| row.get(i)).map(|s| s.trim().to_string()).unwrap_or_default()
        };
        let url = cell(i_url);
        let username = cell(i_user);
        let password = cell(i_pass);

        if password.is_empty() && username.is_empty() {
            skipped += 1;
            continue;
        }

        let title = {
            let named = cell(i_name);
            if named.is_empty() {
                let host = host_of(&url);
                if host.is_empty() { "未命名".to_string() } else { host }
            } else {
                named
            }
        };

        items.push(Entry {
            id: String::new(),
            title,
            username,
            password,
            url,
            category: "网站".into(),
            notes: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        });
    }

    Ok((items, skipped))
}

/// 从 URL 取主机名，去掉 www. 前缀。与 Node 版 `hostOf` 一致。
pub fn host_of(url: &str) -> String {
    let raw = url.trim();
    if raw.is_empty() {
        return String::new();
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };

    // 简易解析：去掉 scheme，取到第一个 / ? # 为止
    let after_scheme = with_scheme
        .split("://")
        .nth(1)
        .unwrap_or(&with_scheme)
        .to_string();
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_string();

    // 去掉端口
    let host = host.split(':').next().unwrap_or("").to_lowercase();
    host.trim_start_matches("www.").to_string()
}

/// 去重键：域名 + 账号。
pub fn dedupe_key(entry: &Entry) -> String {
    let host = host_of(&entry.url);
    let user = entry.username.trim().to_lowercase();
    let fallback = entry.title.trim().to_lowercase();
    let left = if host.is_empty() { fallback } else { host };
    format!("{left}|{user}")
}

/// 导入计划：决定新增 / 覆盖 / 跳过。
pub struct ImportPlan {
    pub add: Vec<Entry>,
    pub update: Vec<(String, String)>, // (id, 新密码)
    pub skipped: usize,
    pub invalid: usize,
}

pub fn plan_import(existing: &[Entry], incoming: Vec<Entry>, overwrite: bool) -> ImportPlan {
    use std::collections::{HashMap, HashSet};

    let mut by_key: HashMap<String, &Entry> = HashMap::new();
    for e in existing {
        by_key.insert(dedupe_key(e), e);
    }

    let mut plan = ImportPlan {
        add: Vec::new(),
        update: Vec::new(),
        skipped: 0,
        invalid: 0,
    };
    let mut seen: HashSet<String> = HashSet::new();

    for mut item in incoming {
        if item.password.is_empty() && item.username.is_empty() {
            plan.invalid += 1;
            continue;
        }
        if item.title.trim().is_empty() {
            let host = host_of(&item.url);
            item.title = if host.is_empty() { "未命名".into() } else { host };
        }

        let key = dedupe_key(&item);
        if seen.contains(&key) {
            plan.skipped += 1;
            continue;
        }
        seen.insert(key.clone());

        match by_key.get(&key) {
            Some(hit) => {
                if overwrite && !item.password.is_empty() {
                    plan.update.push((hit.id.clone(), item.password));
                } else {
                    plan.skipped += 1;
                }
            }
            None => plan.add.push(item),
        }
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_fields() {
        let csv = "name,url,username,password\nGitHub,https://github.com,alice,\"p,a\"\"ss\"\n";
        let (items, _) = items_from_csv(csv).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].password, "p,a\"ss");
    }

    #[test]
    fn handles_crlf_and_bom() {
        let csv = "\u{feff}name,url,username,password\r\nX,https://x.test,u,p\r\n";
        let (items, _) = items_from_csv(csv).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].password, "p");
    }

    #[test]
    fn rejects_missing_password_column() {
        assert!(items_from_csv("name,url,username\nX,u,u\n").is_err());
    }

    #[test]
    fn host_strips_www_and_scheme() {
        assert_eq!(host_of("https://www.GitHub.com/login"), "github.com");
        assert_eq!(host_of("github.com"), "github.com");
    }

    #[test]
    fn dedupe_uses_host_and_user() {
        let a = Entry {
            id: String::new(), title: "A".into(), username: "Alice".into(),
            password: "p".into(), url: "https://www.github.com/".into(),
            category: String::new(), notes: String::new(),
            created_at: String::new(), updated_at: String::new(),
        };
        assert_eq!(dedupe_key(&a), "github.com|alice");
    }
}
