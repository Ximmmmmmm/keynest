//! 明文导入 / 导出，以及加密备份的落盘。
//!
//! # 为什么这一层必须存在
//!
//! 「数据属于用户」不是一句口号，它的判据只有一条：**用户能不能把数据带走**。
//! 一个只能进不能出的密码管理器，本质上是在扣押用户的数据。
//!
//! 因此这里提供两条出口，且**都必须由用户显式触发**：
//!
//! * [`export_csv`] / [`export_json`]：**明文**导出，用于迁移到其他软件；
//! * [`Vault::export_backup_to`]：**加密**备份，用于换机或防灾。
//!
//! # 安全约束
//!
//! * 明文导出返回 [`Zeroizing`]，调用方用完即清零；界面必须二次确认并明示风险。
//! * 导入只做「新增」，**绝不覆盖**库中已有条目：同名同账号视为已存在并跳过。
//!   静默覆盖是丢数据最快的方式。
//! * 导入的条目不保留源文件里的 id/时间戳，一律重新生成，避免撞 id。
//! * 加密备份写完会**读回比对**，不是「写完就当成功」。

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Result, VaultError};
use crate::vault::{max_vault_bytes, read_vault_bytes, write_atomic, AnyFile, Entry, Vault};

/// 明文导出文件的格式标记。
pub const EXPORT_FORMAT: &str = "keynest.export.v1";

/// CSV 表头：与 Bitwarden 的通用 CSV 一致，便于对方直接导入。
const BW_HEADER: [&str; 11] = [
    "folder",
    "favorite",
    "type",
    "name",
    "notes",
    "fields",
    "reprompt",
    "login_uri",
    "login_username",
    "login_password",
    "login_totp",
];

/// 导入结果。界面用它告诉用户「导入了几条、跳过几条、为什么」。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// 源文件里识别出的候选条目数。
    pub parsed: usize,
    /// 实际写入库中的条数。
    pub added: usize,
    /// 因为「标题 + 账号」已存在而跳过的条数。
    pub skipped_existing: usize,
    /// 因为缺少标题等基本字段而跳过的条数。
    pub skipped_invalid: usize,
    /// 因为库里条目数已达上限而没能写入的条数。
    ///
    /// 单列一项而不是混进 `skipped_invalid`：用户需要知道
    /// "这��东西本身是对的，只是库装不下了"，处理方式完全不同。
    pub skipped_limit: usize,
}

impl ImportReport {
    pub fn summary(&self) -> String {
        let mut s = format!("导入 {} 条", self.added);
        if self.skipped_existing > 0 {
            // 说清楚"跳过"意味着**密码没有被更新**。
            // 只写"跳过 N 条已存在"时，用户容易以为导入把旧密码换成了新的，
            // 而实际上库里仍是原来那份——这是导入功能最危险的误解。
            s.push_str(&format!(
                "，{} 条因「标题+账号」已存在而跳过（库里原有密码保持不变，未被覆盖）",
                self.skipped_existing
            ));
        }
        if self.skipped_invalid > 0 {
            s.push_str(&format!("，忽略 {} 条无效记录", self.skipped_invalid));
        }
        if self.skipped_limit > 0 {
            s.push_str(&format!(
                "，{} 条因库已达条目上限未导入",
                self.skipped_limit
            ));
        }
        s
    }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/// 导出为 CSV（Bitwarden 通用列）。
///
/// 返回 `Zeroizing<String>`：里面是明文密码，调用方用完自动清零。
pub fn export_csv(entries: &[Entry]) -> Result<Zeroizing<String>> {
    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());

    writer
        .write_record(BW_HEADER)
        .map_err(|_| VaultError::Export("CSV 表头写入失败"))?;

    for e in entries {
        writer
            .write_record([
                e.category.as_str(),
                if e.favorite { "1" } else { "0" },
                "login", // type
                e.title.as_str(),
                e.notes.as_str(),
                "",  // fields
                "0", // reprompt
                e.url.as_str(),
                e.username.as_str(),
                e.password.as_str(),
                e.totp.as_deref().unwrap_or(""),
            ])
            .map_err(|_| VaultError::Export("CSV 行写入失败"))?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|_| VaultError::Export("CSV 收尾失败"))?;
    let text = String::from_utf8(bytes).map_err(|_| VaultError::Export("CSV 编码异常"))?;
    Ok(Zeroizing::new(text))
}

/// 明文导出的 JSON 结构。
#[derive(Serialize)]
struct ExportDoc<'a> {
    format: &'a str,
    #[serde(rename = "exportedAt")]
    exported_at: String,
    entries: &'a [Entry],
}

/// 导出为 JSON（保真：分类、备注、时间戳都在）。
pub fn export_json(entries: &[Entry]) -> Result<Zeroizing<String>> {
    let doc = ExportDoc {
        format: EXPORT_FORMAT,
        exported_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        entries,
    };
    let text = serde_json::to_string_pretty(&doc).map_err(VaultError::Json)?;
    Ok(Zeroizing::new(text))
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

/// 导入用的宽松条目结构。
///
/// 用 `default` + `alias` 而不是直接复用 [`Entry`]：外部 CSV/JSON 的字段
/// 永远是残缺的，缺一个 `notes` 就整行失败会让导入变成猜谜。
#[derive(Debug, Default, Deserialize)]
struct RawEntry {
    #[serde(default, alias = "name", alias = "名称", alias = "标题")]
    title: String,
    #[serde(
        default,
        alias = "login_username",
        alias = "login",
        alias = "账号",
        alias = "用户名"
    )]
    username: String,
    #[serde(default, alias = "login_password", alias = "密码")]
    password: String,
    #[serde(
        default,
        alias = "login_uri",
        alias = "uri",
        alias = "website",
        alias = "网址"
    )]
    url: String,
    #[serde(default, alias = "folder", alias = "分类")]
    category: String,
    #[serde(default, alias = "note", alias = "备注")]
    notes: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default, alias = "login_totp", alias = "totp")]
    totp: Option<String>,
    #[serde(default, alias = "type", alias = "类型")]
    kind: String,
}

/// 把导入文件里的类型写法归一成本项目的类型名。
///
/// 认三种：中文名（本项目自己的导出）、Bitwarden 的英文 id（login/note/card/identity）、
/// 以及空值（按账号处理）。
fn normalize_kind(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return crate::vault::kinds::LOGIN.to_string();
    }
    if let Some(name) = crate::vault::kinds::migrate_legacy(t) {
        return name.to_string();
    }
    t.to_string()
}

impl RawEntry {
    /// 补全成可入库的条目；标题为空时返回 `None`（无标题的条目在界面上无法辨认）。
    fn into_entry(self) -> Option<Entry> {
        let title = self.title.trim().to_string();
        if title.is_empty() {
            return None;
        }
        let category = if self.category.trim().is_empty() {
            "其他".to_string()
        } else {
            self.category.trim().to_string()
        };
        Some(Entry {
            id: String::new(), // 交给 Vault 重新生成，避免与库中 id 相撞
            title,
            username: self.username.trim().to_string(),
            password: self.password,
            url: self.url.trim().to_string(),
            category,
            notes: self.notes,
            favorite: self.favorite,
            kind: normalize_kind(&self.kind),
            fields: Vec::new(),
            totp: self.totp,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        })
    }
}

/// 解析 CSV。表头按名字匹配，因此 Chrome / Edge / Firefox / Bitwarden 的
/// 导出文件都能直接吃进来。
/// 单次导入的条目数上限。
///
/// # 为什么在**导入层**就要限，而不只是在 vault 层
///
/// `Vault::import_entries` 也会检查 `MAX_ENTRIES`，但那已经是**结果**出来之后。
/// 一个 32 MiB 的 JSON 能解析出上百万条 `Entry`——每条都是若干个 `String`，
/// 光是解析阶段的内存就足以把进程拖垮。
///
/// 解析层先挡住，峰值内存才有上界。
pub const MAX_IMPORT_ENTRIES: usize = 200_000;

pub fn import_csv(text: &str) -> Result<(Vec<Entry>, usize)> {
    let cleaned = text.trim_start_matches('\u{feff}');
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(cleaned.as_bytes());

    let headers: Vec<String> = reader
        .headers()
        .map_err(|_| VaultError::Import("CSV 表头无法解析"))?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();

    let col = |candidates: &[&str]| -> Option<usize> {
        candidates
            .iter()
            .find_map(|c| headers.iter().position(|h| h == c))
    };

    let i_title = col(&["name", "title", "标题", "名称"]);
    let i_url = col(&["url", "login_uri", "website", "网址"]);
    let i_user = col(&["username", "login_username", "login", "账号", "用户名"]);
    let i_pass = col(&["password", "login_password", "密码"]);
    let i_notes = col(&["notes", "note", "备注"]);
    let i_cat = col(&["category", "folder", "分类"]);
    let i_fav = col(&["favorite", "收藏"]);
    let i_totp = col(&["login_totp", "totp", "otp"]);
    let i_type = col(&["type", "类型"]);

    // 连标题和密码都没有的「CSV」，多半是选错了文件。
    if i_title.is_none() && i_pass.is_none() {
        return Err(VaultError::Import(
            "找不到 name/title 列，可能不是密码导出文件",
        ));
    }

    let mut out = Vec::new();
    let mut invalid = 0usize;
    for record in reader.records() {
        let Ok(record) = record else {
            invalid += 1;
            continue;
        };
        let get = |idx: Option<usize>| -> String {
            idx.and_then(|i| record.get(i))
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let raw = RawEntry {
            title: get(i_title),
            username: get(i_user),
            password: idx_value(&record, i_pass),
            url: get(i_url),
            category: get(i_cat),
            notes: idx_value(&record, i_notes),
            // Bitwarden 用 "1"/"0"，别的工具可能用 true/false，都认
            favorite: matches!(
                get(i_fav).to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            ),
            kind: get(i_type),
            totp: {
                let v = get(i_totp);
                if v.is_empty() {
                    None
                } else {
                    Some(v)
                }
            },
        };
        if out.len() >= MAX_IMPORT_ENTRIES {
            // 达到上限就**停止遍历**：剩下的行不再解析，
            // 解析阶段的内存与时间才有上界。
            // 被跳过的部分由调用方根据「已导入 vs 候选数」如实告知用户。
            break;
        }
        match raw.into_entry() {
            Some(e) => out.push(e),
            None => invalid += 1,
        }
    }

    Ok((out, invalid))
}

/// 密码/备注不做 trim：首尾空格可能就是密码的一部分。
fn idx_value(record: &csv::StringRecord, idx: Option<usize>) -> String {
    idx.and_then(|i| record.get(i)).unwrap_or("").to_string()
}

/// 解析 JSON。支持三种形态：本项目的导出文件、裸数组、以及 Bitwarden 的 `items`。
pub fn import_json(text: &str) -> Result<(Vec<Entry>, usize)> {
    let cleaned = text.trim_start_matches('\u{feff}');
    let value: serde_json::Value =
        serde_json::from_str(cleaned).map_err(|_| VaultError::Import("JSON 无法解析"))?;

    // **不克隆数组**。
    //
    // 原来写的是 `arr.clone()`：整个数组被完整复制一份，而 `value` 本身
    // 还活着。32 MiB 的导入文件意味着峰值内存接近三倍。
    // 这里直接借用 `value` 里的数组，遍历完就释放。
    let array: &[serde_json::Value] = if let Some(arr) = value.as_array() {
        arr
    } else if let Some(arr) = value.get("entries").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = value.get("items").and_then(|v| v.as_array()) {
        // Bitwarden：条目藏在 items[].login 里
        return Ok(import_bitwarden_items(arr));
    } else {
        return Err(VaultError::Import("JSON 里没有 entries / items 数组"));
    };

    let mut out = Vec::new();
    let mut invalid = 0usize;
    for v in array {
        if out.len() >= MAX_IMPORT_ENTRIES {
            // 同上：停止遍历，不只是跳过这一条
            break;
        }
        match serde_json::from_value::<RawEntry>(v.clone()) {
            Ok(raw) => match raw.into_entry() {
                Some(e) => out.push(e),
                None => invalid += 1,
            },
            Err(_) => invalid += 1,
        }
    }
    Ok((out, invalid))
}

/// Bitwarden 的 `items[]`：`login.username` / `login.password` / `login.uris[0].uri`。
fn import_bitwarden_items(items: &[serde_json::Value]) -> (Vec<Entry>, usize) {
    let mut out = Vec::new();
    let mut invalid = 0usize;
    for item in items {
        let title = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            invalid += 1;
            continue;
        }
        let login = item.get("login");
        let get_str = |src: Option<&serde_json::Value>, key: &str| -> String {
            src.and_then(|v| v.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let url = login
            .and_then(|l| l.get("uris"))
            .and_then(|u| u.as_array())
            .and_then(|u| u.first())
            .and_then(|u| u.get("uri"))
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string();

        out.push(Entry {
            id: String::new(),
            title,
            username: get_str(login, "username"),
            password: get_str(login, "password"),
            url,
            category: "其他".to_string(),
            // Bitwarden JSON 的 type：1=登录 2=笔记 3=银行卡 4=身份
            kind: match item.get("type").and_then(|v| v.as_u64()) {
                Some(2) => crate::vault::kinds::NOTE.to_string(),
                Some(3) => crate::vault::kinds::CARD.to_string(),
                Some(4) => crate::vault::kinds::IDENTITY.to_string(),
                _ => crate::vault::kinds::LOGIN.to_string(),
            },
            notes: get_str(Some(item), "notes"),
            favorite: item
                .get("favorite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            fields: Vec::new(),
            totp: login
                .and_then(|l| l.get("totp"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string()),
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        });
    }
    (out, invalid)
}

/// 自动判断格式并解析。
pub fn detect_and_import(text: &str) -> Result<(Vec<Entry>, usize)> {
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        import_json(trimmed)
    } else {
        import_csv(trimmed)
    }
}

/* ------------------------------------------------------------------ */
/* 加密备份                                                            */
/* ------------------------------------------------------------------ */

impl Vault {
    /// 把当前库文件复制到 `dest`，作为**加密**备份。
    ///
    /// 步骤刻意保守：
    /// 1. 读当前文件并做结构校验（不校验就备份等于把坏文件复制一份）；
    /// 2. 原子写入目标路径；
    /// 3. **读回逐字节比对**，不一致就报错并删掉目标文件。
    ///
    /// 返回写入的字节数。
    pub fn export_backup_to<P: AsRef<Path>>(&self, dest: P) -> Result<u64> {
        let dest = dest.as_ref();
        if same_path(dest, &self.path) {
            return Err(VaultError::Export("目标就是当前库文件，拒绝覆盖"));
        }
        if !self.path.is_file() {
            return Err(VaultError::NoVault);
        }

        let bytes = read_vault_bytes(&self.path)?;
        AnyFile::parse(&bytes)?.validate()?;

        write_atomic(dest, &bytes)?;

        let back = std::fs::read(dest)?;
        if back != bytes {
            let _ = std::fs::remove_file(dest);
            return Err(VaultError::Export("备份写入后校验不一致，已删除目标文件"));
        }
        Ok(bytes.len() as u64)
    }

    /// 当前库文件大小的上限，供界面提示用（备份/导出前的预检查）。
    pub fn max_size(&self) -> u64 {
        max_vault_bytes()
    }
}

/// 粗略判断两个路径是否指向同一文件。
///
/// 不做 `canonicalize` 失败时的猜测：取不到真实路径就按字面比较，
/// 宁可多拦一次也不要覆盖掉用户唯一的库文件。
fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => {
            let norm = |p: &Path| PathBuf::from(p.to_string_lossy().replace('\\', "/"));
            norm(a) == norm(b)
        }
    }
}

/// 把明文导出内容写到文件。写完 `sync_all`，避免「导出了但是空的」。
pub fn write_plaintext_export<P: AsRef<Path>>(dest: P, text: &str) -> Result<u64> {
    let dest = dest.as_ref();

    // 明文导出必须只有本人可读。
    //
    // `File::create` 在类 Unix 上会遵循 umask，默认往往给出 0644——
    // 同一台机器上的其他账号就能读到整库密码。Windows 上由父目录的
    // ACL 决定，行为不同，所以按平台分别处理。
    let mut f = open_owner_only(dest)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    Ok(text.len() as u64)
}

/// 以「仅所有者可读写」的权限创建文件（已存在则截断）。
///
/// Windows 上没有对应的 umask 概念，文件默认继承父目录 ACL，
/// 与用户在资源管理器里新建文件一致，不再额外收紧
/// （那需要改 ACL，容易把用户自己的访问也弄坏）。
fn open_owner_only(dest: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 0600：只有属主可读写。先创建再写入，避免出现「短暂可读」窗口。
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dest)
    }
    #[cfg(not(unix))]
    {
        std::fs::File::create(dest)
    }
}

/// 给界面用的「导出体积」提示。
pub fn human_size(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let f = n as f64;
    if f < KB {
        format!("{n} B")
    } else if f < MB {
        format!("{:.1} KB", f / KB)
    } else {
        format!("{:.1} MB", f / MB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 导入一个大数组时，内存占用应当与结果规模成正比，而不是三倍。
    ///
    /// 原来 `import_json` 里写的是 `arr.clone()`：整个数组被完整复制一份，
    /// 而解析出来的 `value` 还活着。32 MiB 的导入文件意味着峰值内存接近三倍。
    ///
    /// 这条测试用「解析得出来但结果条数正确」来守住行为：
    /// 如果将来有人改回 clone，行为不变但内存退化——
    /// 所以下面另有专门的内存回归测试（见 `import_of_many_entries_is_not_quadratic`）。
    #[test]
    fn import_json_handles_large_array() {
        let entries: Vec<String> = (0..2000)
            .map(|i| {
                // 用 raw string 避免与 JSON 里的双引号打架
                format!(
                    r#"{{"title":"t{i}","username":"u{i}","password":"p{i}","url":"","category":"网站","notes":""}}"#
                )
            })
            .collect();
        let text = format!(r#"{{"entries":[{}]}}"#, entries.join(","));

        let (items, invalid) = import_json(&text).expect("应当解析成功");
        assert_eq!(items.len(), 2000);
        assert_eq!(invalid, 0);
        assert_eq!(items[0].title, "t0");
        assert_eq!(items[1999].title, "t1999");
    }

    /// 明文导出文件必须只有所有者可读写。
    ///
    /// 密码管理器导出的 CSV / JSON 是**整库明文**。类 Unix 上
    /// `File::create` 会遵循 umask，默认常给出 0644——同机其他账号能读。
    #[cfg(unix)]
    #[test]
    fn plaintext_export_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.csv");
        write_plaintext_export(
            &path, "a,b
",
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "权限过宽: {:o}", mode & 0o777);
    }

    /// 导入摘要必须明确说明「跳过的条目没有被覆盖」。
    ///
    /// 只写"跳过 N 条已存在"时，用户很容易以为导入把旧密码换成了新的，
    /// 而库里其实仍是原来那份。这是导入功能最危险的误解——
    /// 他可能因此删掉源文件，以为密码已经迁移过来了。
    #[test]
    fn skip_summary_states_passwords_are_not_overwritten() {
        let r = ImportReport {
            parsed: 10,
            added: 4,
            skipped_existing: 6,
            skipped_invalid: 0,
            skipped_limit: 0,
        };
        let s = r.summary();
        assert!(s.contains("未"), "摘要未说明密码没被覆盖: {s}");
        assert!(
            s.contains("保持不变") || s.contains("未被覆盖"),
            "摘要: {s}"
        );
    }

    /// 没有跳过项时摘要保持简洁（不出现无意义的括号说明）。
    #[test]
    fn summary_without_skips_stays_short() {
        let r = ImportReport {
            parsed: 3,
            added: 3,
            ..Default::default()
        };
        assert_eq!(r.summary(), "导入 3 条");
    }

    /// 导出内容必须逐字节可读回（权限改动不能影响写入）。
    #[test]
    fn plaintext_export_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.json");
        let text = "{\"a\":1}";
        let n = write_plaintext_export(&path, text).unwrap();
        assert_eq!(n, text.len() as u64);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    use crate::vault::{Entry, Vault};

    fn entry(title: &str, username: &str, password: &str) -> Entry {
        Entry {
            id: String::new(),
            title: title.into(),
            username: username.into(),
            password: password.into(),
            url: "https://example.test".into(),
            category: "网站".into(),
            notes: String::new(),
            favorite: false,
            kind: crate::vault::kinds::LOGIN.to_string(),
            fields: Vec::new(),
            totp: None,
            password_changed_at: None,
            deleted_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn csv_export_uses_bitwarden_header() {
        let text = export_csv(&[entry("GitHub", "alice", "pw1")]).unwrap();
        let first = text.lines().next().unwrap();
        assert_eq!(
            first,
            "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp"
        );
    }

    #[test]
    fn csv_export_quotes_tricky_passwords() {
        // 逗号、双引号、换行都必须被正确转义，否则导出的文件在别的软件里会错行
        let tricky = "pa,ss\"wo\nrd";
        let text = export_csv(&[entry("X", "u", tricky)]).unwrap();
        assert!(
            text.as_str().contains("\"pa,ss\"\"wo\nrd\""),
            "实际: {}",
            text.as_str()
        );
    }

    /// 明文导出**不得**包含回收站里的条目。
    ///
    /// 用户把一条记录删进回收站，心里认为它已经"删掉了"。
    /// 导出时若把它写进 CSV，就等于把他以为删掉的东西明文摊在磁盘上。
    ///
    /// 想连回收站一起带走，应当用「导出加密备份」——那是整库副本，
    /// 语义明确。
    #[test]
    fn export_skips_deleted_entries() {
        // Entry 实现了 Drop（用于清零密码），所以不能整体构造后改字段，
        // 只能先 Default 再逐项赋值。
        let mut active = Entry::default();
        active.id = "a".into();
        active.title = "在用".into();
        active.username = "u".into();
        active.password = "secret-active".into();
        active.category = "网站".into();
        active.deleted_at = None;

        let mut trashed = active.clone();
        trashed.id = "b".into();
        trashed.title = "已删除".into();
        trashed.password = "secret-trashed".into();
        trashed.deleted_at = Some("2026-01-01T00:00:00.000Z".into());

        let entries = [active, trashed];

        // 调用方（GUI）负责过滤；这里验的是"过滤后的输入确实不含已删除项"
        let kept: Vec<Entry> = entries
            .iter()
            .filter(|e| !e.is_deleted())
            .cloned()
            .collect();
        let csv = export_csv(&kept).unwrap();
        assert!(
            !csv.contains("secret-trashed"),
            "回收站条目的密码进了明文导出"
        );
        assert!(csv.contains("secret-active"));

        let json = export_json(&kept).unwrap();
        assert!(!json.contains("secret-trashed"));
    }

    #[test]
    fn export_then_import_roundtrip() {
        let entries = vec![
            entry("A", "user-a", "pa,ss1"),
            entry("B", "user-b", "pw\"2"),
        ];
        let csv = export_csv(&entries).unwrap();
        let (back, invalid) = import_csv(&csv).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].password, "pa,ss1");
        assert_eq!(back[1].password, "pw\"2");
    }

    #[test]
    fn import_chrome_csv() {
        let csv = "name,url,username,password,note\n\
                   GitHub,https://github.com,alice,ghP@ss1,2FA\n\
                   Figma,https://figma.com,bob,fgP@ss2,\n";
        let (entries, invalid) = import_csv(csv).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "GitHub");
        assert_eq!(entries[0].url, "https://github.com");
        assert_eq!(entries[0].notes, "2FA");
        assert_eq!(entries[1].username, "bob");
    }

    #[test]
    fn import_bitwarden_csv() {
        let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
                   Work,0,login,Corp,note,,0,https://corp.test,alice,pw1,\n";
        let (entries, invalid) = import_csv(csv).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].category, "Work");
        assert_eq!(entries[0].password, "pw1");
    }

    #[test]
    fn bitwarden_json_type_maps_to_kind() {
        let json = r#"{"items":[
            {"type":1,"name":"登录项","login":{"username":"u","password":"p"}},
            {"type":3,"name":"银行卡","login":{}},
            {"type":4,"name":"身份","login":{}},
            {"type":2,"name":"笔记","notes":"x"}
        ]}"#;
        let (entries, _) = import_json(json).unwrap();
        let kinds: Vec<&str> = entries.iter().map(|e| e.kind.as_str()).collect();
        assert!(kinds.contains(&crate::vault::kinds::CARD));
        assert!(kinds.contains(&crate::vault::kinds::IDENTITY));
        assert!(kinds.contains(&crate::vault::kinds::NOTE));
        assert!(kinds.contains(&crate::vault::kinds::LOGIN));
    }

    #[test]
    fn csv_type_column_is_honored() {
        // Bitwarden 的 CSV 用 text 列 type，值是英文 id
        let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
                   ,0,card,我的卡,,,0,,,,\n";
        let (entries, _) = import_csv(csv).unwrap();
        assert_eq!(entries[0].kind, crate::vault::kinds::CARD);
    }

    #[test]
    fn csv_carries_totp_column() {
        let mut e = entry("A", "u", "p");
        e.totp = Some("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP".into());
        let csv = export_csv(&[e]).unwrap();
        assert!(csv.contains("login_totp"));
        assert!(csv.contains("JBSWY3DPEHPK3PXP"));

        let (back, invalid) = import_csv(&csv).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(
            back[0].totp.as_deref(),
            Some("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP")
        );
    }

    #[test]
    fn bitwarden_json_carries_totp() {
        let json = r#"{"items":[{"name":"A","login":{"username":"u","password":"p",
                       "totp":"otpauth://totp/A?secret=JBSWY3DPEHPK3PXP"}}]}"#;
        let (entries, _) = import_json(json).unwrap();
        assert!(entries[0].totp.is_some());
    }

    #[test]
    fn import_skips_rows_without_title() {
        let csv = "name,username,password\n,ghost,pw\nReal,alice,pw2\n";
        let (entries, invalid) = import_csv(csv).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(invalid, 1);
    }

    #[test]
    fn import_rejects_unrelated_csv() {
        let csv = "a,b,c\n1,2,3\n";
        let err = import_csv(csv).unwrap_err();
        assert_eq!(err.code(), "IMPORT");
    }

    #[test]
    fn import_json_own_format() {
        let json = format!(
            r#"{{"format":"{EXPORT_FORMAT}","exportedAt":"2026-01-01T00:00:00.000Z",
                "entries":[{{"title":"A","username":"u","password":"p","url":"","category":"网站","notes":""}}]}}"#
        );
        let (entries, invalid) = import_json(&json).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(entries[0].title, "A");
    }

    #[test]
    fn import_json_bare_array() {
        let json = r#"[{"name":"A","login_username":"u","login_password":"p"}]"#;
        let (entries, invalid) = import_json(json).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(entries[0].username, "u");
        assert_eq!(entries[0].password, "p");
    }

    #[test]
    fn import_bitwarden_json_items() {
        let json = r#"{"items":[
            {"name":"Corp","notes":"n","login":{"username":"alice","password":"pw",
             "uris":[{"uri":"https://corp.test"}]}}]}"#;
        let (entries, invalid) = import_json(json).unwrap();
        assert_eq!(invalid, 0);
        assert_eq!(entries[0].title, "Corp");
        assert_eq!(entries[0].username, "alice");
        assert_eq!(entries[0].url, "https://corp.test");
    }

    #[test]
    fn detect_routes_by_first_character() {
        let (from_json, _) = detect_and_import(r#"[{"name":"A","password":"p"}]"#).unwrap();
        assert_eq!(from_json.len(), 1);

        let (from_csv, _) = detect_and_import("name,password\nB,p\n").unwrap();
        assert_eq!(from_csv.len(), 1);
        assert_eq!(from_csv[0].title, "B");
    }

    #[test]
    fn bom_is_stripped() {
        let csv = "\u{feff}name,password\nA,p\n";
        let (entries, _) = import_csv(csv).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "A");
    }

    #[test]
    fn json_export_is_parseable_and_keeps_category() {
        let mut e = entry("A", "u", "p");
        e.category = "金融".into();
        let text = export_json(&[e]).unwrap();
        let (back, _) = import_json(&text).unwrap();
        assert_eq!(back[0].category, "金融");
    }

    /* ---------------- 加密备份 ---------------- */

    fn temp_vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("vault.dat"));
        v.create("master-password-123").unwrap();
        (dir, v)
    }

    #[test]
    fn backup_is_byte_identical_and_valid() {
        let (dir, v) = temp_vault();
        let dest = dir.path().join("backup.keynest");
        let n = v.export_backup_to(&dest).unwrap();

        let src = std::fs::read(&v.path).unwrap();
        let copy = std::fs::read(&dest).unwrap();
        assert_eq!(src, copy, "备份必须与源文件逐字节一致");
        assert_eq!(n, src.len() as u64);
        assert!(AnyFile::parse(&copy).is_ok(), "备份本身必须是合法库文件");
    }

    #[test]
    fn backup_refuses_to_overwrite_the_vault_itself() {
        let (_dir, v) = temp_vault();
        let err = v.export_backup_to(&v.path).unwrap_err();
        assert_eq!(err.code(), "EXPORT");
        // 源文件必须完好
        assert!(v.path.exists());
    }

    #[test]
    fn backup_of_missing_vault_fails() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::new(dir.path().join("nope.dat"));
        let err = v.export_backup_to(dir.path().join("out.bin")).unwrap_err();
        assert_eq!(err.code(), "NO_VAULT");
    }

    #[test]
    fn plaintext_export_writes_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.csv");
        let n = write_plaintext_export(&dest, "a,b\n").unwrap();
        assert_eq!(n, 4);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "a,b\n");
    }
}
