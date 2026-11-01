//! 钥巢的加密仓库核心。
//!
//! 纯逻辑，**不含 UI、不含 WebView、不含 Tauri**。
//!
//! # 两代格式
//!
//! ```text
//! v2（新建默认）
//!   主密码 ──Argon2id(64MiB, t=3, p=1, 16B 随机盐)──> 32B 主密钥
//!        └─> XChaCha20-Poly1305（24B 随机 nonce，每次保存重新生成）
//!
//! v1（仅兼容读取）
//!   主密码 ──scrypt(N=2^17, r=8, p=1, 16B 随机盐)──> 32B 主密钥
//!        └─> AES-256-GCM（12B 随机 IV，每次保存重新生成）
//! ```
//!
//! 两种格式的 AAD 都绑定「格式 + KDF 算法 + KDF 参数 + 盐」，
//! 任何一项被改动都会导致解认证失败。
//!
//! # 模块
//!
//! * [`vault`] —— 加密仓库本体（KDF、AEAD、原子写入）
//! * [`password`] —— 密码生成与强度评估
//! * [`secure`] —— 剪贴板定时清除、系统级闲置检测（仅 Windows）
//! * [`paths`] —— 数据目录解析（优先 `%LOCALAPPDATA%`）
//! * [`error`] —— 错误类型（保证不泄漏秘密）

pub mod error;
pub mod keymem;
pub mod lockfile;
pub mod password;
pub mod paths;
pub mod portable;
pub mod secure;
pub mod totp;
pub mod vault;

pub use error::{Result, VaultError};
pub use keymem::SecretKey;
pub use lockfile::InstanceLock;
pub use portable::{detect_and_import, export_csv, export_json, ImportReport};
pub use totp::Totp;
pub use vault::{
    kinds, AnyFile, BackupInfo, CipherParams, DekWrap, Entry, Field, FieldTemplate, KdfParams,
    Settings, TypeDef, Vault, VaultData, VaultFile, VaultFileV3, ALGO_ARGON2ID, ALGO_SCRYPT,
    BACKUP_GENERATIONS, DEFAULT_CATEGORIES, FORMAT, FORMAT_V1, FORMAT_V2, FORMAT_V3,
    MAX_VAULT_BYTES, MIN_MASTER_LEN,
};
