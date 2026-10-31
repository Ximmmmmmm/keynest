//! CSV 自动发现。与 Node 版 `csv-discovery.js` 行为一致：
//! 扫描下载 / 桌面 / 文档，优先返回 5 分钟内修改过的文件，支持多文件合并。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const MAX_CSV_BYTES: u64 = 20 * 1024 * 1024;
pub const FRESH_WINDOW: Duration = Duration::from_secs(5 * 60);
pub const MAX_FILES: usize = 10;

#[derive(Debug, Clone)]
pub struct CsvFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub age: Duration,
}

impl CsvFile {
    /// 人性化年龄，与 Node 版 `describeAge` 一致。
    pub fn age_label(&self) -> String {
        let minutes = self.age.as_secs() / 60;
        if minutes < 1 {
            "刚刚".into()
        } else if minutes < 60 {
            format!("{minutes} 分钟前")
        } else {
            let hours = minutes / 60;
            if hours < 24 {
                format!("{hours} 小时前")
            } else {
                format!("{} 天前", hours / 24)
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub found: bool,
    pub confident: bool,
    pub truncated: bool,
    pub files: Vec<CsvFile>,
}

/// 默认扫描目录：下载 / 桌面 / 文档。
pub fn default_dirs() -> Vec<PathBuf> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    if home.is_empty() {
        return Vec::new();
    }
    let base = PathBuf::from(home);
    vec![
        base.join("Downloads"),
        base.join("Desktop"),
        base.join("Documents"),
    ]
}

fn collect(dir: &Path, now: SystemTime, fresh: &mut Vec<CsvFile>, stale: &mut Vec<CsvFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.to_lowercase().ends_with(".csv") {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() == 0 || meta.len() > MAX_CSV_BYTES {
            continue;
        }

        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();

        let file = CsvFile {
            path,
            name,
            size: meta.len(),
            age,
        };

        if age <= FRESH_WINDOW {
            fresh.push(file);
        } else {
            stale.push(file);
        }
    }
}

fn sort_newest(files: &mut Vec<CsvFile>) {
    files.sort_by(|a, b| {
        a.age
            .cmp(&b.age)
            .then_with(|| a.path.to_string_lossy().cmp(&b.path.to_string_lossy()))
    });
}

/// 发现待导入的 CSV 集合。
pub fn discover(dirs: &[PathBuf]) -> Discovery {
    let now = SystemTime::now();
    let mut fresh = Vec::new();
    let mut stale = Vec::new();

    for dir in dirs {
        collect(dir, now, &mut fresh, &mut stale);
    }
    sort_newest(&mut fresh);
    sort_newest(&mut stale);

    let (mut files, confident) = if fresh.is_empty() {
        (stale, false)
    } else {
        (fresh, true)
    };

    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);

    Discovery {
        found: !files.is_empty(),
        confident,
        truncated,
        files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn touch(dir: &Path, name: &str, age_secs: u64) -> PathBuf {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(b"name,url,username,password\n").unwrap();
        drop(f);
        // 用 filetime 语义需要额外依赖，这里只验证发现逻辑本身
        let _ = age_secs;
        p
    }

    #[test]
    fn finds_csv_files() {
        let dir = std::env::temp_dir().join(format!("kn-disc-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        touch(&dir, "a.csv", 0);
        touch(&dir, "b.txt", 0);

        let d = discover(&[dir.clone()]);
        assert!(d.found);
        assert_eq!(d.files.len(), 1);
        assert_eq!(d.files[0].name, "a.csv");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_dir_reports_not_found() {
        let dir = std::env::temp_dir().join(format!("kn-empty-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let d = discover(&[dir.clone()]);
        assert!(!d.found);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn age_label_readable() {
        let f = CsvFile {
            path: PathBuf::from("x.csv"),
            name: "x.csv".into(),
            size: 10,
            age: Duration::from_secs(5),
        };
        assert_eq!(f.age_label(), "刚刚");

        let f2 = CsvFile { age: Duration::from_secs(300), ..f.clone() };
        assert_eq!(f2.age_label(), "5 分钟前");
    }
}
