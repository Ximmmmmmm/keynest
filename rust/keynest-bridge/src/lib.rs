//! 钥巢浏览器桥（阶段 1）。
//!
//! ```text
//! 浏览器扩展 ──Native Messaging──► keynest-native-host ──加密管道──► keynest-egui
//! ```
//!
//! # 这个 crate 刻意不做什么
//!
//! - **不打开 vault.dat**：没有任何文件路径、没有任何解密代码。
//!   密码库只能由 GUI 进程通过 [`VaultOps`] 提供。
//! - **不接触主密码 / KEK / DEK**：这里连 `keynest-core` 都不依赖。
//! - **不记录密码**：错误信息只描述字段名与上限，不带宽窄内容。
//!
//! 第 1 条是这套架构的核心不变量：即使这个进程被攻破，也拿不到密码库文件。

pub mod auth;
pub mod error;
pub mod framing;
pub mod keyfile;
pub mod limits;
pub mod pipe;
pub mod protocol;
pub mod server;
pub mod watchdog;

pub use error::BridgeError;
pub use limits::*;
pub use protocol::{Command, LockState, Request, Response};
/// 让下游（GUI）不必为了一个 Value 类型再加一次 serde_json 依赖。
pub use serde_json;
pub use server::{serve, VaultOps};

/// 桥接层的自述版本，写进 `status` 回包，便于排查"扩展和 GUI 版本不匹配"。
pub const BRIDGE_VERSION: &str = env!("CARGO_PKG_VERSION");
