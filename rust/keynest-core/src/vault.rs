//! 加密仓库核心，与 Node 版 `src/main/vault.js` 格式完全兼容。
//!
//! 兼容性靠三层保证：
//!   1. 文件结构逐字段一致（`format` / `kdf` / `cipher` / `payload`）
//!   2. AAD 的 JSON 序列化字节一致（决定能否解开对方的文件）
//!   3. scrypt 参数一致（N=2^17, r=8, p=1, 32 字节输出）

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use rand::rngs::OsRng;
use rand::RngCore;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::error::{Result, VaultError};

pub const FORMAT: &str = "keynest.v1";
pub const CIPHER_ALGO: &str = "aes-256-gcm";
pub const KEY_LEN: usize = 32;
pub const MIN_MASTER_LEN: usize = 8;
pub const MAXMEM: u32 = 512 * 1024 * 1024;

pub const DEFAULT_CATEGORIES: [&str; 5] = ["网站", "邮箱", "应用", "金融", "其他"];

/// scrypt 参数。与 Node 版 `DEFAULT_KDF` 一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub algo: String,
    #[serde(rename = "N")]
    pub n: u64,
    pub r: u32,
    pub p: u32,
    pub salt: String,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            algo: "scrypt".into(),
            n: 1 << 17,
            r: 8,
            p: 1,
            salt: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CipherParams {
    pub algo: String,
    pub iv: String,
    pub tag: String,
}

/// 磁盘上的文件结构。字段顺序与 Node 版一致。
#[derive(Debug, Serialize, Deserialize)]
pub struct VaultFile {
    pub format: String,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "autoLockMinutes")]
    pub auto_lock_minutes: u32,
    #[serde(rename = "clipboardClearSeconds")]
    pub clipboard_clear_seconds: u32,
    #[serde(rename = "revealSeconds")]
    pub reveal_seconds: u32,
    #[serde(rename = "importPrompted")]
    pub import_prompted: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 30,
            reveal_seconds: 20,
            import_prompted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub category: String,
    pub notes: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultData {
    pub version: u32,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub settings: Settings,
    pub categories: Vec<String>,
    pub entries: Vec<Entry>,
}

impl Default for VaultData {
    fn default() -> Self {
        Self {
            version: 1,
            created_at: now_iso(),
            updated_at: now_iso(),
            settings: Settings::default(),
            categories: DEFAULT_CATEGORIES.iter().map(|s| s.to_string()).collect(),
            entries: Vec::new(),
        }
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>> {
    B64.decode(text).map_err(|e| VaultError::Crypto(e.to_string()))
}

/// 与 Node 版 `aadOf()` 完全一致的 AAD 构造。
///
/// 注意：JSON 的键顺序必须一致（Node 的 JSON.stringify 按插入顺序输出），
/// 这里用固定结构体序列化，保证字节一致。
#[derive(Serialize)]
struct AadShape<'a> {
    format: &'a str,
    kdf: AadKdf<'a>,
    salt: &'a str,
}

#[derive(Serialize)]
struct AadKdf<'a> {
    algo: &'a str,
    #[serde(rename = "N")]
    n: u64,
    r: u32,
    p: u32,
}

fn aad_of(kdf: &KdfParams) -> Vec<u8> {
    let shape = AadShape {
        format: FORMAT,
        kdf: AadKdf {
            algo: &kdf.algo,
            n: kdf.n,
            r: kdf.r,
            p: kdf.p,
        },
        salt: &kdf.salt,
    };
    serde_json::to_vec(&shape).unwrap_or_default()
}

fn derive_key(password: &str, salt: &[u8], params: &KdfParams) -> Result<[u8; KEY_LEN]> {
    // scrypt 的 log_n：Node 传的是 N 本身，这里要转成 log2(N)
    let log_n = (params.n as f64).log2() as u8;
    let sp = Params::new(log_n, params.r, params.p, KEY_LEN)
        .map_err(|e| VaultError::Kdf(e.to_string()))?;

    let mut key = [0u8; KEY_LEN];
    scrypt(password.as_bytes(), salt, &sp, &mut key)
        .map_err(|e| VaultError::Kdf(e.to_string()))?;
    Ok(key)
}

pub struct Vault {
    pub path: PathBuf,
    key: Option<[u8; KEY_LEN]>,
    header: Option<KdfParams>,
    data: Option<VaultData>,
}

impl Vault {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            key: None,
            header: None,
            data: None,
        }
    }

    pub fn backup_path(&self) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(".bak");
        PathBuf::from(p)
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    pub fn create(&mut self, master: &str) -> Result<VaultData> {
        if self.exists() {
            return Err(VaultError::AlreadyExists);
        }
        if master.chars().count() < MIN_MASTER_LEN {
            return Err(VaultError::WeakPassword(MIN_MASTER_LEN));
        }

        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let kdf = KdfParams {
            salt: b64(&salt),
            ..Default::default()
        };
        let key = derive_key(master, &salt, &kdf)?;

        self.key = Some(key);
        self.header = Some(kdf);
        self.data = Some(VaultData::default());
        self.save()?;

        Ok(self.data.clone().unwrap())
    }

    pub fn unlock(&mut self, master: &str) -> Result<VaultData> {
        let raw = fs::read_to_string(&self.path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                VaultError::NoVault
            } else {
                VaultError::Corrupt
            }
        })?;

        let file: VaultFile = serde_json::from_str(&raw).map_err(|_| VaultError::Corrupt)?;
        if file.format != FORMAT {
            return Err(VaultError::UnsupportedFormat);
        }

        let salt = unb64(&file.kdf.salt)?;
        let key = derive_key(master, &salt, &file.kdf)?;

        let nonce_bytes = unb64(&file.cipher.iv)?;
        let tag_bytes = unb64(&file.cipher.tag)?;
        let payload = unb64(&file.payload)?;

        // AES-GCM：Rust 的 aes-gcm 把 tag 附在密文尾部
        let mut ciphertext_with_tag = payload;
        ciphertext_with_tag.extend_from_slice(&tag_bytes);

        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = aad_of(&file.kdf);

        let plain = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ciphertext_with_tag,
                    aad: &aad,
                },
            )
            .map_err(|_| VaultError::InvalidPassword)?;

        let data: VaultData = serde_json::from_slice(&plain).map_err(|_| VaultError::Corrupt)?;

        self.key = Some(key);
        self.header = Some(file.kdf);
        self.data = Some(data.clone());
        Ok(data)
    }

    pub fn lock(&mut self) {
        if let Some(mut k) = self.key.take() {
            k.zeroize();
        }
        self.header = None;
        self.data = None;
    }

    pub fn snapshot(&self) -> Result<VaultData> {
        self.data.clone().ok_or(VaultError::Locked)
    }

    pub fn save(&mut self) -> Result<()> {
        let key = self.key.ok_or(VaultError::Locked)?;
        let header = self.header.clone().ok_or(VaultError::Locked)?;
        let mut data = self.data.clone().ok_or(VaultError::Locked)?;

        data.updated_at = now_iso();
        let plain = serde_json::to_vec(&data)?;

        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);

        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| VaultError::Crypto(e.to_string()))?;
        let nonce = Nonce::from_slice(&iv);
        let aad = aad_of(&header);

        let encrypted = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: &plain,
                    aad: &aad,
                },
            )
            .map_err(|e| VaultError::Crypto(e.to_string()))?;

        // aes-gcm 输出 = 密文 || tag（tag 是最后 16 字节）
        let split = encrypted.len() - 16;
        let (ciphertext, tag) = encrypted.split_at(split);

        let file = VaultFile {
            format: FORMAT.to_string(),
            kdf: header,
            cipher: CipherParams {
                algo: CIPHER_ALGO.into(),
                iv: b64(&iv),
                tag: b64(tag),
            },
            updated_at: data.updated_at.clone(),
            payload: b64(ciphertext),
        };

        // 1) 备份上一版
        if self.path.exists() {
            let _ = fs::copy(&self.path, self.backup_path());
        }

        // 2) 原子写入：临时文件 → rename
        let tmp = self.path.with_extension("dat.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;

        self.data = Some(data);
        Ok(())
    }

    pub fn upsert_entry(&mut self, mut entry: Entry) -> Result<Entry> {
        let mut data = self.data.clone().ok_or(VaultError::Locked)?;

        if entry.title.trim().is_empty() {
            return Err(VaultError::InvalidEntry);
        }
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
            entry.created_at = now_iso();
        }
        entry.updated_at = now_iso();

        match data.entries.iter_mut().find(|e| e.id == entry.id) {
            Some(existing) => *existing = entry.clone(),
            None => data.entries.insert(0, entry.clone()),
        }
        if !data.categories.contains(&entry.category) {
            data.categories.push(entry.category.clone());
        }

        self.data = Some(data);
        self.save()?;
        Ok(entry)
    }

    /// 直接替换内存中的数据结构（供 update_settings / add_category 使用）。
    pub fn replace_data(&mut self, data: VaultData) {
        self.data = Some(data);
    }

    /// 换主密码：新盐、重新派生、整体重加密。
    pub fn change_master(&mut self, old_password: &str, new_password: &str) -> Result<()> {
        if new_password.chars().count() < MIN_MASTER_LEN {
            return Err(VaultError::WeakPassword(MIN_MASTER_LEN));
        }

        // 验证旧密码
        let header = self.header.clone().ok_or(VaultError::Locked)?;
        let salt = unb64(&header.salt)?;
        let old_key = derive_key(old_password, &salt, &header)?;
        let current = self.key.ok_or(VaultError::Locked)?;
        if old_key != current {
            return Err(VaultError::InvalidPassword);
        }

        // 换新盐与新密钥
        let mut new_salt = [0u8; 16];
        OsRng.fill_bytes(&mut new_salt);
        let new_header = KdfParams {
            salt: b64(&new_salt),
            ..header
        };
        let new_key = derive_key(new_password, &new_salt, &new_header)?;

        if let Some(mut k) = self.key.take() {
            k.zeroize();
        }
        self.key = Some(new_key);
        self.header = Some(new_header);
        self.save()?;

        // 备份也要用新密码重写
        let _ = fs::copy(&self.path, self.backup_path());
        Ok(())
    }

    /// 彻底删除仓库与备份。
    pub fn wipe(&mut self) -> Result<()> {
        self.lock();
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(self.backup_path());
        let tmp = self.path.with_extension("dat.tmp");
        let _ = fs::remove_file(tmp);
        Ok(())
    }

    pub fn delete_entry(&mut self, id: &str) -> Result<()> {
        let mut data = self.data.clone().ok_or(VaultError::Locked)?;
        let before = data.entries.len();
        data.entries.retain(|e| e.id != id);
        if data.entries.len() == before {
            return Err(VaultError::NotFound);
        }
        self.data = Some(data);
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aad_matches_node_shape() {
        let kdf = KdfParams {
            salt: "AAAA".into(),
            ..Default::default()
        };
        let aad = aad_of(&kdf);
        let text = String::from_utf8(aad).unwrap();
        // Node 的键顺序：format, kdf{algo,N,r,p}, salt
        assert!(text.starts_with("{\"format\":\"keynest.v1\",\"kdf\":{\"algo\":\"scrypt\""));
        assert!(text.contains("\"N\":131072"));
        assert!(text.ends_with(",\"salt\":\"AAAA\"}"));
    }
}
