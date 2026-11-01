//! 错误类型。
//!
//! 安全要点：这里的每一条 `#[error(...)]` 都**不得**携带主密码、派生密钥、
//! 明文密码片段。底层库的错误只保留类型信息，不把原始数据拼进字符串。

use thiserror::Error;

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("仓库已存在")]
    AlreadyExists,

    #[error("尚未创建仓库")]
    NoVault,

    /// 只报告「要求的最小长度」，不回显用户输入的密码。
    #[error("主密码至少 {0} 位")]
    WeakPassword(usize),

    /// 统一为一条文案：不区分「密码错」与「认证标签错」，
    /// 避免给攻击者提供判定信息。
    #[error("主密码错误，或仓库文件已损坏")]
    InvalidPassword,

    #[error("仓库文件格式不受支持")]
    UnsupportedFormat,

    #[error("仓库文件无法解析，可能已损坏")]
    Corrupt,

    /// 结构合法但字段非法（例如 nonce 长度不对、KDF 参数越界）。
    /// 携带静态描述，绝不携带文件内容。
    #[error("仓库文件字段非法: {0}")]
    Malformed(&'static str),

    #[error("仓库已锁定")]
    Locked,

    /// 库文件在本次解锁之后被其他程序改动过。
    ///
    /// 继续保存会把对方的改动整体覆盖掉，因此这里选择中止并交给用户决定。
    #[error("仓库文件已被其他程序修改，为防止覆盖对方的改动已中止保存")]
    ExternalChange,

    #[error("备份文件不可用")]
    NoBackup,

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

    /// 只携带静态原因，不拼接底层错误详情（底层可能含内存地址等信息）。
    #[error("加密失败: {0}")]
    Crypto(&'static str),

    #[error("密钥派生失败: {0}")]
    Kdf(&'static str),

    #[error("系统随机数不可用")]
    Random,

    #[error("剪贴板操作失败: {0}")]
    Clipboard(&'static str),

    #[error("导出失败: {0}")]
    Export(&'static str),

    /// 导入失败只携带静态原因：源文件内容可能含明文密码，绝不能拼进错误串。
    #[error("导入失败: {0}")]
    Import(&'static str),

    /// TOTP 相关错误。只带静态原因：密钥本身绝不能出现在错误串里。
    #[error("验证码密钥无效: {0}")]
    Totp(&'static str),
}

impl VaultError {
    /// 稳定的错误码，便于前端统一处理。
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::AlreadyExists => "ALREADY_EXISTS",
            VaultError::NoVault => "NO_VAULT",
            VaultError::WeakPassword(_) => "WEAK_PASSWORD",
            VaultError::InvalidPassword => "INVALID_PASSWORD",
            VaultError::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            VaultError::Corrupt => "CORRUPT",
            VaultError::Malformed(_) => "CORRUPT",
            VaultError::Locked => "LOCKED",
            VaultError::ExternalChange => "EXTERNAL_CHANGE",
            VaultError::NoBackup => "NO_BACKUP",
            VaultError::NotFound => "NOT_FOUND",
            VaultError::InvalidEntry => "INVALID_ENTRY",
            VaultError::InvalidCategory => "INVALID_CATEGORY",
            VaultError::Io(_) => "IO",
            VaultError::Json(_) => "CORRUPT",
            VaultError::Crypto(_) => "CRYPTO",
            VaultError::Kdf(_) => "KDF",
            VaultError::Random => "RANDOM",
            VaultError::Clipboard(_) => "CLIPBOARD",
            VaultError::Export(_) => "EXPORT",
            VaultError::Import(_) => "IMPORT",
            VaultError::Totp(_) => "TOTP",
        }
    }
}
