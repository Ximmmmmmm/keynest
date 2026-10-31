//! 读取 Chromium 的 Login Data，并用 DPAPI 解密 v10/v11 密码。
//!
//! 与 Node 版的关键差异：DPAPI 直接在进程内调用。
//! Node 版需要 `execFileSync('powershell.exe', [...])`，每次约 300ms，
//! 且密钥以 base64 字符串跨进程传递；这里零子进程、零字符串中转。
//!
//! v20（应用绑定加密）依然读不了 —— 密钥由 elevation_service 保管，
//! 它校验调用方签名。这一点 Node 版和 Rust 版结论相同。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserSource {
    pub id: String,
    pub name: String,
    pub profiles: Vec<ProfileInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileInfo {
    pub dir: String,
    pub label: String,
    pub count: i64,
    pub app_bound: i64,
    pub importable: i64,
}

/// 已知的 Chromium 系浏览器。
pub fn browser_roots() -> Vec<(&'static str, &'static str, PathBuf)> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if local.is_empty() {
        return Vec::new();
    }
    let base = PathBuf::from(local);
    vec![
        ("chrome", "Google Chrome", base.join("Google/Chrome/User Data")),
        ("edge", "Microsoft Edge", base.join("Microsoft/Edge/User Data")),
        ("brave", "Brave", base.join("BraveSoftware/Brave-Browser/User Data")),
        ("chromium", "Chromium", base.join("Chromium/User Data")),
    ]
}

fn is_profile_dir(name: &str) -> bool {
    name == "Default" || name.starts_with("Profile ")
}

/// 扫描本机浏览器配置。只统计密码版本，不解密。
pub fn scan() -> Vec<BrowserSource> {
    let mut out = Vec::new();

    for (id, name, root) in browser_roots() {
        if !root.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };

        let mut profiles = Vec::new();
        for entry in entries.flatten() {
            let dir_name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if !is_profile_dir(&dir_name) {
                continue;
            }
            let db = entry.path().join("Login Data");
            if !db.exists() {
                continue;
            }

            let (count, app_bound, importable) = analyze(&db).unwrap_or((-1, 0, 0));
            profiles.push(ProfileInfo {
                label: if dir_name == "Default" { "默认配置".into() } else { dir_name.clone() },
                dir: dir_name,
                count,
                app_bound,
                importable,
            });
        }

        if !profiles.is_empty() {
            out.push(BrowserSource {
                id: id.to_string(),
                name: name.to_string(),
                profiles,
            });
        }
    }

    out
}

/// 统计一个配置文件的密码版本。返回 (总数, v20 数量, 可导入数量)。
fn analyze(db_path: &Path) -> Result<(i64, i64, i64), String> {
    let tmp_dir = std::env::temp_dir().join(format!("kn-scan-{}", uuid_like()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let copy = tmp_dir.join("Login Data");

    let result = (|| -> Result<(i64, i64, i64), String> {
        std::fs::copy(db_path, &copy).map_err(|e| e.to_string())?;

        let db = crate::browser::sqlite::SqliteFile::open(&copy)?;

        let mut total = 0i64;
        let mut app_bound = 0i64;
        let mut importable = 0i64;

        for blob in db.blob_columns() {
            // 只关心密码 blob：以 v10/v11/v20 开头
            if blob.len() < 3 {
                continue;
            }
            let prefix = &blob[..3];
            let is_crypt = matches!(prefix, b"v10" | b"v11" | b"v20");
            if !is_crypt {
                continue;
            }
            total += 1;
            if prefix == b"v20" {
                app_bound += 1;
            } else {
                importable += 1;
            }
        }

        Ok((total, app_bound, importable))
    })();

    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/* ---------------- DPAPI ---------------- */

#[cfg(windows)]
mod dpapi {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    use windows::Win32::Foundation::LocalFree;

    /// 用当前用户身份解开 DPAPI blob。进程内调用，无子进程。
    pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut input = CRYPT_INTEGER_BLOB {
                cbData: blob.len() as u32,
                pbData: blob.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };

            let ok = CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output);
            if ok.is_err() {
                return Err(format!(
                    "CryptUnprotectData 失败: {:?}",
                    windows::core::Error::from_win32()
                ));
            }

            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let result = slice.to_vec();
            // 释放 DPAPI 分配的内存。HLOCAL 是 Copy 类型，直接传值即可。
            LocalFree(windows::Win32::Foundation::HLOCAL(output.pbData as *mut core::ffi::c_void));
            Ok(result)
        }
    }
}

/// 解密一条 v10/v11 密码。
///
/// 布局：`v10`(3B) + nonce(12B) + ciphertext + tag(16B)，AES-256-GCM。
#[cfg(windows)]
pub fn decrypt_v10(blob: &[u8], key: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    if blob.len() < 3 + 12 + 16 {
        return Err("密文长度异常".into());
    }
    let nonce = Nonce::from_slice(&blob[3..15]);
    let tag = &blob[blob.len() - 16..];
    let ciphertext = &blob[15..blob.len() - 16];

    let mut ct_with_tag = ciphertext.to_vec();
    ct_with_tag.extend_from_slice(tag);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(nonce, ct_with_tag.as_ref())
        .map_err(|_| "GCM 解密失败".to_string())?;

    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// 从 Local State 读出 DPAPI 保护的主密钥。
#[cfg(windows)]
pub fn read_local_state_key(root: &Path) -> Result<Vec<u8>, String> {
    let file = root.join("Local State");
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let encrypted = json["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or("Local State 里没有 encrypted_key")?;

    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encrypted)
        .map_err(|e| e.to_string())?;

    if raw.len() < 5 || &raw[..5] != b"DPAPI" {
        return Err("密钥前缀不是 DPAPI".into());
    }

    dpapi::unprotect(&raw[5..])
}

#[cfg(not(windows))]
pub fn decrypt_v10(_blob: &[u8], _key: &[u8]) -> Result<String, String> {
    Err("仅支持 Windows".into())
}
