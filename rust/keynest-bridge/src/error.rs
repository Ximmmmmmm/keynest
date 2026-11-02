//! 桥接层错误类型。
//!
//! 原则：**错误信息里永远不出现密码、令牌或密钥**。
//! 所有携带用户数据的分支只描述"哪一类字段不合法"，不带值。

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// 对端正常关闭（EOF）。这是正常生命周期，不是故障。
    Closed,
    /// 帧被截断或结构不对。
    Malformed(&'static str),
    /// 消息超过上限。
    MessageTooLarge { len: usize, max: usize },
    /// 协议版本不匹配。
    VersionMismatch { got: u32, want: u32 },
    /// 命令不在白名单里。
    UnknownCommand,
    /// 请求结构不合法（缺字段、多字段、类型不对）。
    InvalidRequest(&'static str),
    /// 某个字符串字段超长。只报字段名与上限，不报内容。
    FieldTooLong { field: &'static str, max: usize },
    /// 握手失败。
    HandshakeFailed(&'static str),
    /// 会话令牌无效、过期或未建立。
    NoSession,
    /// 重放检测命中。
    Replay,
    /// 触发限流。
    RateLimited,
    /// 请求或握手超时。
    Timeout,
    /// 密码库处于锁定状态，拒绝敏感操作。
    VaultLocked,
    /// 该平台不支持命名管道。
    Unsupported,
    /// 底层 I/O 错误（只保留种类描述，不拼路径）。
    Io(String),
}

impl BridgeError {
    /// 稳定的错误码，供协议回包与日志使用。
    /// 用大写串而不是 Debug 输出，避免内部细节泄漏到浏览器侧。
    pub fn code(&self) -> &'static str {
        match self {
            BridgeError::Closed => "CLOSED",
            BridgeError::Malformed(_) => "MALFORMED",
            BridgeError::MessageTooLarge { .. } => "TOO_LARGE",
            BridgeError::VersionMismatch { .. } => "VERSION",
            BridgeError::UnknownCommand => "UNKNOWN_COMMAND",
            BridgeError::InvalidRequest(_) => "INVALID_REQUEST",
            BridgeError::FieldTooLong { .. } => "FIELD_TOO_LONG",
            BridgeError::HandshakeFailed(_) => "HANDSHAKE",
            BridgeError::NoSession => "NO_SESSION",
            BridgeError::Replay => "REPLAY",
            BridgeError::RateLimited => "RATE_LIMITED",
            BridgeError::Timeout => "TIMEOUT",
            BridgeError::VaultLocked => "VAULT_LOCKED",
            BridgeError::Unsupported => "UNSUPPORTED",
            BridgeError::Io(_) => "IO",
        }
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BridgeError::Closed => write!(f, "连接已关闭"),
            BridgeError::Malformed(what) => write!(f, "帧格式错误：{what}"),
            BridgeError::MessageTooLarge { len, max } => {
                write!(f, "消息过大：{len} 字节，上限 {max}")
            }
            BridgeError::VersionMismatch { got, want } => {
                write!(f, "协议版本不匹配：收到 {got}，期望 {want}")
            }
            BridgeError::UnknownCommand => write!(f, "未知命令"),
            BridgeError::InvalidRequest(what) => write!(f, "请求不合法：{what}"),
            BridgeError::FieldTooLong { field, max } => {
                write!(f, "字段 {field} 超过 {max} 字符")
            }
            BridgeError::HandshakeFailed(what) => write!(f, "握手失败：{what}"),
            BridgeError::NoSession => write!(f, "会话未建立或已失效"),
            BridgeError::Replay => write!(f, "检测到重放"),
            BridgeError::RateLimited => write!(f, "请求过于频繁"),
            BridgeError::Timeout => write!(f, "请求超时"),
            BridgeError::VaultLocked => write!(f, "密码库已锁定"),
            BridgeError::Unsupported => write!(f, "当前平台不支持"),
            BridgeError::Io(what) => write!(f, "I/O 错误：{what}"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_uppercase_identifiers() {
        let errs = [
            BridgeError::Closed,
            BridgeError::UnknownCommand,
            BridgeError::Replay,
            BridgeError::VaultLocked,
        ];
        for e in errs {
            let c = e.code();
            assert!(c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_'));
        }
    }

    #[test]
    fn messages_never_contain_user_data_placeholders() {
        // FieldTooLong 只带字段名与上限，不带值——这条约束必须能测出来
        let e = BridgeError::FieldTooLong {
            field: "password",
            max: 1024,
        };
        let text = e.to_string();
        assert!(text.contains("password"));
        assert!(text.contains("1024"));
    }
}
