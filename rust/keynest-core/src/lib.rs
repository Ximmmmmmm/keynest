//! 钥巢的加密仓库核心。
//!
//! 与 Node 版 `src/main/vault.js` **格式完全兼容**：
//! 同一个 `vault.dat` 两边都能打开，解出的 JSON 字节一致。
//!
//! ```text
//! 主密码 ──scrypt(N=2^17, r=8, p=1, 16B 随机盐)──> 32B 主密钥
//!                                                      │
//!                                          AES-256-GCM（每次保存新 IV）
//!                                                      ↓
//! vault.dat = { format, kdf{algo,N,r,p,salt}, cipher{iv,tag}, payload }
//! ```

pub mod error;
pub mod password;
pub mod vault;

pub use error::{VaultError, Result};
pub use vault::{Vault, VaultData, Entry, Settings, KdfParams, FORMAT, DEFAULT_CATEGORIES};
