//! 错误类型。

use thiserror::Error;

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("仓库已存在")]
    AlreadyExists,

    #[error("尚未创建仓库")]
    NoVault,

    #[error("主密码至少 {0} 位")]
    WeakPassword(usize),

    #[error("主密码错误，或仓库文件已损坏")]
    InvalidPassword,

    #[error("仓库文件格式不受支持")]
    UnsupportedFormat,

    #[error("仓库文件无法解析，可能已损坏")]
    Corrupt,

    #[error("仓库已锁定")]
    Locked,

    #[error("条目不存在")]
    NotFound,

    #[error("标题不能为空")]
    InvalidEntry,

    #[error("分类名不能为空")]
    InvalidCategory,

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("加密错误: {0}")]
    Crypto(String),

    #[error("密钥派生失败: {0}")]
    Kdf(String),
}

impl VaultError {
    /// 稳定的错误码，与 Node 版保持一致，便于前端统一处理。
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::AlreadyExists => "ALREADY_EXISTS",
            VaultError::NoVault => "NO_VAULT",
            VaultError::WeakPassword(_) => "WEAK_PASSWORD",
            VaultError::InvalidPassword => "INVALID_PASSWORD",
            VaultError::UnsupportedFormat => "CORRUPT",
            VaultError::Corrupt => "CORRUPT",
            VaultError::Locked => "LOCKED",
            VaultError::NotFound => "NOT_FOUND",
            VaultError::InvalidEntry => "INVALID_ENTRY",
            VaultError::InvalidCategory => "INVALID_CATEGORY",
            VaultError::Io(_) => "IO",
            VaultError::Json(_) => "CORRUPT",
            VaultError::Crypto(_) => "CRYPTO",
            VaultError::Kdf(_) => "KDF",
        }
    }
}
