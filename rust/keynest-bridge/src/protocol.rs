//! 协议：命令白名单、请求/响应结构、以及"拒绝而不是宽容"的解析规则。
//!
//! 设计要点：**未知字段直接拒绝**（`deny_unknown_fields`）。
//! 宽容解析在这里是负资产——它会让攻击者塞进去的字段被静默忽略，
//! 而在排查时又看不出来。

use serde::{Deserialize, Serialize};

use crate::error::BridgeError;
use crate::limits::{
    MAX_ID_LEN, MAX_ORIGIN_LEN, MAX_PASSWORD_LEN, MAX_TITLE_LEN, MAX_URL_LEN, MAX_USERNAME_LEN,
    PROTOCOL_VERSION,
};

/// 认证状态。GUI 锁定后，除 `status` 外的命令一律拒绝。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockState {
    Locked,
    Unlocked,
}

/// 白名单命令。
///
/// 只有这六个。新增命令必须同时改这里、改 `handlers` 和测试，
/// 不会出现"某处偷偷多支持了一种操作"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Hello,
    Status,
    VaultQuery,
    VaultFill,
    VaultSave,
    VaultConflict,
}

impl Command {
    pub fn as_str(self) -> &'static str {
        match self {
            Command::Hello => "hello",
            Command::Status => "status",
            Command::VaultQuery => "vault.query",
            Command::VaultFill => "vault.fill",
            Command::VaultSave => "vault.save",
            Command::VaultConflict => "vault.conflict",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, BridgeError> {
        match raw {
            "hello" => Ok(Command::Hello),
            "status" => Ok(Command::Status),
            "vault.query" => Ok(Command::VaultQuery),
            "vault.fill" => Ok(Command::VaultFill),
            "vault.save" => Ok(Command::VaultSave),
            "vault.conflict" => Ok(Command::VaultConflict),
            _ => Err(BridgeError::UnknownCommand),
        }
    }

    /// 锁定状态下是否允许。
    ///
    /// 只有 `hello` 与 `status` 允许——它们不接触任何密码数据，
    /// 是扩展显示"KeyNest 已锁定"所必需的。
    pub fn allowed_when_locked(self) -> bool {
        matches!(self, Command::Hello | Command::Status)
    }
}

/// 线上传输的请求信封。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub id: String,
    pub cmd: String,
    /// 握手前为空；握手后是服务端签发的令牌。
    #[serde(default)]
    pub session: Option<String>,
    /// 命令参数。形状由 `cmd` 决定，在这里保持为 JSON 值，
    /// 由各命令自己用 `deny_unknown_fields` 的结构体二次解析。
    #[serde(default)]
    pub payload: serde_json::Value,
}

impl Request {
    pub fn command(&self) -> Result<Command, BridgeError> {
        Command::parse(&self.cmd)
    }

    /// 结构校验：版本、id 长度、命令合法性。
    pub fn validate(&self) -> Result<Command, BridgeError> {
        if self.v != PROTOCOL_VERSION {
            return Err(BridgeError::VersionMismatch {
                got: self.v,
                want: PROTOCOL_VERSION,
            });
        }
        if self.id.is_empty() {
            return Err(BridgeError::InvalidRequest("缺少 id"));
        }
        if self.id.chars().count() > MAX_ID_LEN {
            return Err(BridgeError::FieldTooLong {
                field: "id",
                max: MAX_ID_LEN,
            });
        }
        self.command()
    }
}

/// 线上传输的响应信封。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub v: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    /// 稳定错误码（如 `VAULT_LOCKED`）。用 String 而不是 &'static str，
    /// 否则 Response 无法反序列化——测试需要用同一套类型解析回包。
    pub code: String,
    pub message: String,
}

impl Response {
    pub fn ok(id: &str, payload: serde_json::Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: id.to_string(),
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn err(id: &str, e: &BridgeError) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: id.to_string(),
            ok: false,
            payload: None,
            error: Some(ErrorBody {
                code: e.code().to_string(),
                message: e.to_string(),
            }),
        }
    }
}

/* ------------------------------------------------------------------ */
/* 各命令的 payload                                                   */
/* ------------------------------------------------------------------ */

/// `vault.query` —— **不返回密码**。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryPayload {
    pub origin: String,
}

/// `vault.fill` —— 唯一会返回密码的命令。
///
/// `confirm` 是扩展在用户点击"填充"后生成的一次性令牌；
/// 网页脚本无法伪造，因为它拿不到用户点击的上下文。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillPayload {
    pub entry_id: String,
    pub origin: String,
    pub confirm: String,
}

/// `vault.save` —— 用户确认后的写入请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavePayload {
    pub origin: String,
    pub title: String,
    pub username: String,
    pub password: String,
    /// true 表示更新已有 `entry_id`，false 表示新建
    #[serde(default)]
    pub update: bool,
    #[serde(default)]
    pub entry_id: Option<String>,
}

/// 查询返回的单条摘要（**不含密码**）。
#[derive(Debug, Clone, Serialize)]
pub struct EntrySummary {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
}

/// 字段级校验：集中在一处，避免某个命令忘了查长度。
pub fn check_str(field: &'static str, value: &str, max: usize) -> Result<(), BridgeError> {
    if value.chars().count() > max {
        return Err(BridgeError::FieldTooLong { field, max });
    }
    Ok(())
}

pub fn validate_query(p: &QueryPayload) -> Result<(), BridgeError> {
    check_str("origin", &p.origin, MAX_ORIGIN_LEN)?;
    if p.origin.is_empty() {
        return Err(BridgeError::InvalidRequest("origin 不能为空"));
    }
    Ok(())
}

pub fn validate_fill(p: &FillPayload) -> Result<(), BridgeError> {
    check_str("entry_id", &p.entry_id, MAX_ID_LEN)?;
    check_str("origin", &p.origin, MAX_ORIGIN_LEN)?;
    check_str("confirm", &p.confirm, 128)?;
    if p.confirm.is_empty() {
        return Err(BridgeError::InvalidRequest("缺少 confirm 令牌"));
    }
    Ok(())
}

pub fn validate_save(p: &SavePayload) -> Result<(), BridgeError> {
    check_str("title", &p.title, MAX_TITLE_LEN)?;
    check_str("username", &p.username, MAX_USERNAME_LEN)?;
    check_str("password", &p.password, MAX_PASSWORD_LEN)?;
    check_str("origin", &p.origin, MAX_ORIGIN_LEN)?;
    if let Some(id) = &p.entry_id {
        check_str("entry_id", id, MAX_ID_LEN)?;
    }
    if p.update && p.entry_id.is_none() {
        return Err(BridgeError::InvalidRequest("update=true 但没有 entry_id"));
    }
    Ok(())
}

/// `status` 的返回体：扩展靠它显示"未运行 / 已锁定 / 已解锁"。
#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    pub protocol: u32,
    pub locked: bool,
    pub version: String,
}

/// 供 URL 长度校验用的占位，避免编译器警告未使用的常量。
pub const _URL_MAX: usize = MAX_URL_LEN;

#[cfg(test)]
mod tests {
    use super::*;

    fn req(json: &str) -> Request {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn valid_request_parses() {
        let r = req(r#"{"v":1,"id":"abc","cmd":"status"}"#);
        assert_eq!(r.validate().unwrap(), Command::Status);
    }

    #[test]
    fn unknown_field_is_rejected_not_ignored() {
        let e = serde_json::from_str::<Request>(r#"{"v":1,"id":"a","cmd":"status","extra":1}"#);
        assert!(e.is_err(), "未知字段必须报错，不能被静默忽略");
    }

    #[test]
    fn unknown_command_is_rejected() {
        let r = req(r#"{"v":1,"id":"a","cmd":"vault.delete"}"#);
        assert!(matches!(r.validate(), Err(BridgeError::UnknownCommand)));
    }

    #[test]
    fn version_mismatch_is_rejected() {
        let r = req(r#"{"v":2,"id":"a","cmd":"status"}"#);
        assert!(matches!(
            r.validate(),
            Err(BridgeError::VersionMismatch { .. })
        ));
    }

    #[test]
    fn only_status_and_hello_survive_lock() {
        assert!(Command::Hello.allowed_when_locked());
        assert!(Command::Status.allowed_when_locked());
        assert!(!Command::VaultQuery.allowed_when_locked());
        assert!(!Command::VaultFill.allowed_when_locked());
        assert!(!Command::VaultSave.allowed_when_locked());
        assert!(!Command::VaultConflict.allowed_when_locked());
    }

    #[test]
    fn save_requires_entry_id_when_updating() {
        let p = SavePayload {
            origin: "https://example.com".into(),
            title: "t".into(),
            username: "u".into(),
            password: "p".into(),
            update: true,
            entry_id: None,
        };
        assert!(matches!(
            validate_save(&p),
            Err(BridgeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn oversized_field_is_reported_by_name_only() {
        let p = SavePayload {
            origin: "https://example.com".into(),
            title: "t".into(),
            username: "u".into(),
            password: "x".repeat(MAX_PASSWORD_LEN + 1),
            update: false,
            entry_id: None,
        };
        let e = validate_save(&p).unwrap_err();
        let text = e.to_string();
        assert!(text.contains("password"));
        // 不能把密码本身拼进错误信息
        assert!(!text.contains("xxxx"));
    }

    #[test]
    fn fill_requires_confirm_token() {
        let p = FillPayload {
            entry_id: "e1".into(),
            origin: "https://example.com".into(),
            confirm: String::new(),
        };
        assert!(validate_fill(&p).is_err());
    }

    #[test]
    fn response_error_has_stable_code() {
        let r = Response::err("id1", &BridgeError::VaultLocked);
        assert!(!r.ok);
        assert_eq!(r.error.as_ref().unwrap().code, "VAULT_LOCKED");
    }
}
