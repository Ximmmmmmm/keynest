//! 协议层常量与上限。
//!
//! 所有上限都集中在这里，测试与实现共用一个来源——散落在各处的魔数
//! 是"某处忘了校验"的温床。

/// 协议版本。不匹配的请求直接拒绝，不做兼容降级：
/// 版本不一致意味着双方对字段含义的理解可能不同，猜比拒绝危险。
pub const PROTOCOL_VERSION: u32 = 1;

/// 单条 Native Messaging 消息的硬上限。
///
/// Chrome 官方上限是 1 MiB（从扩展发往 host 为 64 MiB，但我们对内收得更紧）。
/// 真正需要传的只有条目字段，1 MiB 已经绰绰有余；
/// 收紧上限是为了让"巨型消息"这条路根本走不通。
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// 字段级长度上限（字符数，不是字节）。
pub const MAX_TITLE_LEN: usize = 256;
pub const MAX_USERNAME_LEN: usize = 320;
pub const MAX_PASSWORD_LEN: usize = 1024;
pub const MAX_URL_LEN: usize = 2048;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_ORIGIN_LEN: usize = 512;

/// JSON 嵌套深度上限。防止深层嵌套把解析器拖进长递归。
pub const MAX_JSON_DEPTH: usize = 8;

/// 每会话每分钟允许的请求数。
pub const RATE_LIMIT_PER_MINUTE: u32 = 300;

/// 单次请求从收到到回复的容忍时间。
pub const REQUEST_TIMEOUT_MS: u64 = 3_000;

/// 握手必须在连接建立后这么久之内完成。
pub const HANDSHAKE_TIMEOUT_MS: u64 = 5_000;

/// 会话密钥的有效期。过期必须重新握手。
pub const SESSION_TTL_SECS: u64 = 60 * 30;

/// 握手 challenge 的字节数。
pub const CHALLENGE_LEN: usize = 32;

/// 会话令牌长度。
pub const SESSION_TOKEN_LEN: usize = 16;

/// AEAD nonce 长度（XChaCha20-Poly1305 固定 24 字节）。
pub const NONCE_LEN: usize = 24;

/// 会话密钥长度。
pub const SESSION_KEY_LEN: usize = 32;

#[cfg(test)]
mod tests {
    use super::*;

    // 这些是**编译期**不变量：上限之间必须互相自洽。
    // 用 const 断言而不是 #[test]，配置改坏时编译就失败，而不是等到跑测试。
    const _: () = {
        assert!(MAX_MESSAGE_BYTES >= 64 * 1024);
        assert!(MAX_MESSAGE_BYTES <= 1024 * 1024);
        assert!(MAX_PASSWORD_LEN < MAX_MESSAGE_BYTES);
        assert!(MAX_URL_LEN > MAX_ORIGIN_LEN);
        assert!(CHALLENGE_LEN == 32);
        assert!(NONCE_LEN == 24);
        assert!(SESSION_KEY_LEN == 32);
    };

    #[test]
    fn protocol_version_matches_document() {
        // 版本号变更必须同步更新架构文档，这条测试是提醒
        assert_eq!(PROTOCOL_VERSION, 1);
    }
}
