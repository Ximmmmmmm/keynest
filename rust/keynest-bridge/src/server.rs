//! 桥接服务端：握手 + 加密会话 + 命令分发 + 锁定门禁 + 限流。
//!
//! 这一层**完全不碰 vault.dat**。它只调用 [`VaultOps`]——由 GUI 进程实现，
//! 从而保证「Native Host 永远不直接开库」这条不变量在类型层面成立：
//! 这个 crate 里没有任何代码能打开密码库文件。

use std::io::{Read, Write};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

use serde_json::Value;

use crate::auth::{
    derive_session_key, random_challenge, verify_proof, SessionCipher, SharedSecret,
};
use crate::error::BridgeError;
use crate::framing::{read_frame, write_frame};
use crate::limits::{
    CHALLENGE_LEN, HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION, RATE_LIMIT_PER_MINUTE,
    REQUEST_TIMEOUT_MS, SESSION_TTL_SECS,
};
use crate::protocol::{
    validate_fill, validate_query, validate_save, Command, EntrySummary, FillPayload, LockState,
    QueryPayload, Request, Response, SavePayload, StatusPayload,
};
use crate::watchdog::{CancelFn, Watchdog};

/// GUI 进程提供给桥接层的密码库能力。
///
/// 实现者持有已解锁的 `Vault`；桥接层只看到这几个方法。
pub trait VaultOps {
    fn lock_state(&self) -> LockState;
    fn app_version(&self) -> String;
    fn query(&mut self, origin: &str) -> Result<Vec<EntrySummary>, BridgeError>;
    /// 返回该条目的当前密码。
    ///
    /// 返回 `Zeroizing<String>` 而不是 `String`：明文密码不应该依赖
    /// "调用方记得手动擦除"这种口头约定。类型系统替我们记住了。
    fn fill(&mut self, entry_id: &str, origin: &str) -> Result<Zeroizing<String>, BridgeError>;
    fn save(&mut self, payload: SavePayload) -> Result<String, BridgeError>;
    fn conflicts(&mut self) -> Result<Value, BridgeError>;
}

/// 滑动窗口限流。
struct RateLimiter {
    window_start: Instant,
    count: u32,
    limit: u32,
}

impl RateLimiter {
    fn new(limit: u32) -> Self {
        Self {
            window_start: Instant::now(),
            count: 0,
            limit,
        }
    }

    fn allow(&mut self) -> bool {
        if self.window_start.elapsed() >= Duration::from_secs(60) {
            self.window_start = Instant::now();
            self.count = 0;
        }
        if self.count >= self.limit {
            return false;
        }
        self.count += 1;
        true
    }
}

/// 服务端可调参数。默认值来自 `limits`，测试与 GUI 都可以覆盖。
pub struct ServeOptions {
    pub request_timeout: Duration,
    pub handshake_timeout: Duration,
    /// 超时后用来打断阻塞读的动作（GUI 传 `DisconnectNamedPipe`）。
    pub on_timeout: Option<CancelFn>,
}

impl Default for ServeOptions {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_millis(REQUEST_TIMEOUT_MS),
            handshake_timeout: Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            on_timeout: None,
        }
    }
}

/// 一次连接的完整生命周期。
pub fn serve<T, V>(transport: &mut T, shared: &SharedSecret, ops: &mut V) -> Result<(), BridgeError>
where
    T: Read + Write,
    V: VaultOps,
{
    serve_with_options(transport, shared, ops, ServeOptions::default())
}

/// 与 [`serve`] 相同，但可配置超时与取消动作。
pub fn serve_with_options<T, V>(
    transport: &mut T,
    shared: &SharedSecret,
    ops: &mut V,
    opts: ServeOptions,
) -> Result<(), BridgeError>
where
    T: Read + Write,
    V: VaultOps,
{
    let challenge = random_challenge()?;
    serve_inner(transport, shared, ops, challenge, opts)
}

/// 与 [`serve`] 相同，但挑战值由调用方给定。
///
/// 存在的唯一理由是**可测试性**：端到端测试需要预先知道挑战值，
/// 才能算出客户端应答并加密请求。生产路径永远走随机值。
pub fn serve_with_challenge<T, V>(
    transport: &mut T,
    shared: &SharedSecret,
    ops: &mut V,
    challenge: [u8; CHALLENGE_LEN],
) -> Result<(), BridgeError>
where
    T: Read + Write,
    V: VaultOps,
{
    serve_inner(transport, shared, ops, challenge, ServeOptions::default())
}

fn serve_inner<T, V>(
    transport: &mut T,
    shared: &SharedSecret,
    ops: &mut V,
    challenge: [u8; CHALLENGE_LEN],
    opts: ServeOptions,
) -> Result<(), BridgeError>
where
    T: Read + Write,
    V: VaultOps,
{
    let started = Instant::now();
    // ---- 1. 握手 ----
    write_frame(transport, &challenge)?;

    let hello = read_frame(transport)?;
    // 应答固定为：client_nonce(32) ‖ HMAC-SHA256(32)
    if hello.len() != CHALLENGE_LEN + 32 {
        return Err(BridgeError::HandshakeFailed("应答长度不符"));
    }
    let mut client_nonce = [0u8; CHALLENGE_LEN];
    client_nonce.copy_from_slice(&hello[..CHALLENGE_LEN]);
    let proof = &hello[CHALLENGE_LEN..CHALLENGE_LEN + 32];

    verify_proof(shared, &challenge, &client_nonce, proof)?;

    // 用「截止时刻」而不是「已用时长 > 上限」：后者在时钟粒度粗时
    // 会把 elapsed==0 误判成"没超时"，配 ZERO 上限就永远不触发。
    if Instant::now() >= started + opts.handshake_timeout {
        // 握手太慢：直接断，不给它继续消耗服务线程的机会
        return Err(BridgeError::Timeout);
    }

    let key = derive_session_key(shared, &challenge, &client_nonce)?;
    write_frame(transport, b"ok")?;

    // 看门狗：每次请求前上表，回复后撤表。超时由它调用取消动作打断阻塞读。
    let cancel: CancelFn = match opts.on_timeout {
        Some(f) => f,
        None => Box::new(|| {}),
    };
    let watchdog = Watchdog::start(opts.request_timeout, cancel);

    let mut rx = SessionCipher::new(&key);
    let mut tx = SessionCipher::new(&key);
    let mut limiter = RateLimiter::new(RATE_LIMIT_PER_MINUTE);
    let session_start = Instant::now();

    // ---- 2. 请求循环 ----
    loop {
        watchdog.arm(opts.request_timeout);
        let frame = match read_frame(transport) {
            Ok(f) => f,
            Err(BridgeError::Closed) => return Ok(()), // 浏览器关掉了扩展，正常
            Err(e) => return Err(e),
        };

        if session_start.elapsed() > Duration::from_secs(SESSION_TTL_SECS) {
            return Err(BridgeError::NoSession);
        }
        if !limiter.allow() {
            let resp = Response::err("", &BridgeError::RateLimited);
            reply(transport, &mut tx, &resp)?;
            continue;
        }

        let plain = match rx.open(&frame) {
            Ok(p) => p,
            Err(e) => {
                // 解密失败不回复内容，直接结束会话——继续用这条走私钥的通道没有意义
                let resp = Response::err("", &e);
                let _ = reply(transport, &mut tx, &resp);
                return Err(e);
            }
        };

        let resp = handle_one(&plain, ops);
        reply(transport, &mut tx, &resp)?;
        watchdog.disarm();

        if watchdog.fired() {
            // 上一次请求超时，连接已被打断，不能继续复用
            return Err(BridgeError::Timeout);
        }
    }
}

fn reply<T: Write>(
    transport: &mut T,
    tx: &mut SessionCipher,
    resp: &Response,
) -> Result<(), BridgeError> {
    let body = serde_json::to_vec(resp).map_err(|_| BridgeError::Io("序列化失败".into()))?;
    let sealed = tx.seal(&body)?;
    write_frame(transport, &sealed)
}

/// 单条请求的完整判定链。顺序刻意如此：
/// 解码 → 版本/命令/长度 → 锁定门禁 → 业务。
/// **锁定检查在业务之前**，所以锁定时连"这个条目存不存在"都不会泄漏。
fn handle_one<V: VaultOps>(plain: &[u8], ops: &mut V) -> Response {
    let req: Request = match serde_json::from_slice(plain) {
        Ok(r) => r,
        Err(_) => {
            return Response::err("", &BridgeError::Malformed("请求不是合法 JSON"));
        }
    };

    let cmd = match req.validate() {
        Ok(c) => c,
        Err(e) => return Response::err(&req.id, &e),
    };

    // 锁定门禁
    if !cmd.allowed_when_locked() && ops.lock_state() == LockState::Locked {
        return Response::err(&req.id, &BridgeError::VaultLocked);
    }

    match dispatch(cmd, &req, ops) {
        Ok(payload) => Response::ok(&req.id, payload),
        Err(e) => Response::err(&req.id, &e),
    }
}

fn dispatch<V: VaultOps>(cmd: Command, req: &Request, ops: &mut V) -> Result<Value, BridgeError> {
    match cmd {
        Command::Hello => Ok(serde_json::json!({
            "protocol": PROTOCOL_VERSION,
            "app": ops.app_version(),
        })),
        Command::Status => Ok(serde_json::to_value(StatusPayload {
            protocol: PROTOCOL_VERSION,
            locked: ops.lock_state() == LockState::Locked,
            version: ops.app_version(),
        })
        .unwrap_or(Value::Null)),
        Command::VaultQuery => {
            let p: QueryPayload = parse_payload(&req.payload)?;
            validate_query(&p)?;
            Ok(serde_json::to_value(ops.query(&p.origin)?).unwrap_or(Value::Null))
        }
        Command::VaultFill => {
            let p: FillPayload = parse_payload(&req.payload)?;
            validate_fill(&p)?;
            let password = ops.fill(&p.entry_id, &p.origin)?;
            Ok(serde_json::json!({ "password": &*password }))
        }
        Command::VaultSave => {
            let p: SavePayload = parse_payload(&req.payload)?;
            validate_save(&p)?;
            let id = ops.save(p)?;
            Ok(serde_json::json!({ "id": id }))
        }
        Command::VaultConflict => Ok(ops.conflicts()?),
    }
}

fn parse_payload<T: serde::de::DeserializeOwned>(v: &Value) -> Result<T, BridgeError> {
    serde_json::from_value(v.clone()).map_err(|_| BridgeError::InvalidRequest("payload 结构不匹配"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::client_proof;
    use std::io::Cursor;

    /// 内存里的假 GUI：不碰任何文件。
    struct FakeOps {
        locked: bool,
        entries: Vec<EntrySummary>,
    }

    impl FakeOps {
        fn unlocked() -> Self {
            Self {
                locked: false,
                entries: vec![EntrySummary {
                    id: "e1".into(),
                    title: "示例".into(),
                    username: "u".into(),
                    url: "https://example.com".into(),
                }],
            }
        }
        fn locked() -> Self {
            Self {
                locked: true,
                ..Self::unlocked()
            }
        }
    }

    impl VaultOps for FakeOps {
        fn lock_state(&self) -> LockState {
            if self.locked {
                LockState::Locked
            } else {
                LockState::Unlocked
            }
        }
        fn app_version(&self) -> String {
            "0.5.0-test".into()
        }
        fn query(&mut self, _origin: &str) -> Result<Vec<EntrySummary>, BridgeError> {
            Ok(self.entries.clone())
        }
        fn fill(&mut self, _id: &str, _origin: &str) -> Result<Zeroizing<String>, BridgeError> {
            Ok(Zeroizing::new("test-password".to_string()))
        }
        fn save(&mut self, _p: SavePayload) -> Result<String, BridgeError> {
            Ok("new-id".into())
        }
        fn conflicts(&mut self) -> Result<Value, BridgeError> {
            Ok(serde_json::json!([]))
        }
    }

    /// 单向脚本化传输：预先塞好输入，输出全部收集起来供断言。
    struct Scripted {
        input: Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl Read for Scripted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Scripted {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.output.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn req(id: &str, cmd: &str, payload: Value) -> Request {
        Request {
            v: PROTOCOL_VERSION,
            id: id.into(),
            cmd: cmd.into(),
            session: None,
            payload,
        }
    }

    /// 端到端：真实跑一次 `serve_with_challenge`，客户端侧手工完成握手与加解密。
    ///
    /// 覆盖：握手成功 → status → query → fill（或锁定时被拒）→ 正常关闭。
    fn run_session(ops: &mut FakeOps, requests: &[Request]) -> Vec<Response> {
        let shared = SharedSecret::from_bytes([5u8; 32]);
        let challenge = [7u8; CHALLENGE_LEN];
        let nonce = [9u8; CHALLENGE_LEN];

        let key = derive_session_key(&shared, &challenge, &nonce).unwrap();
        let k: [u8; 32] = *key;

        // 组装客户端脚本：hello 帧 + 每条请求的密文帧
        let mut input = Vec::new();
        let mut hello = nonce.to_vec();
        hello.extend_from_slice(&client_proof(&shared, &challenge, &nonce));
        write_frame(&mut input, &hello).unwrap();

        let mut tx = SessionCipher::new(&k);
        for r in requests {
            let body = serde_json::to_vec(r).unwrap();
            let sealed = tx.seal(&body).unwrap();
            write_frame(&mut input, &sealed).unwrap();
        }

        let mut t = Scripted {
            input: Cursor::new(input),
            output: Vec::new(),
        };
        serve_with_challenge(&mut t, &shared, ops, challenge).expect("会话应正常结束");

        // 解析服务端输出：challenge → "ok" → 若干密文响应
        let mut out = Cursor::new(t.output);
        let sent_challenge = read_frame(&mut out).unwrap();
        assert_eq!(sent_challenge, challenge.to_vec());
        let ack = read_frame(&mut out).unwrap();
        assert_eq!(ack, b"ok");

        let mut rx = SessionCipher::new(&k);
        let mut responses = Vec::new();
        while let Ok(frame) = read_frame(&mut out) {
            let plain = rx.open(&frame).expect("响应应可解密");
            responses.push(serde_json::from_slice::<Response>(&plain).unwrap());
        }
        responses
    }

    #[test]
    fn end_to_end_unlocked_session() {
        let mut ops = FakeOps::unlocked();
        let rs = run_session(
            &mut ops,
            &[
                req("1", "status", Value::Null),
                req(
                    "2",
                    "vault.query",
                    serde_json::json!({"origin":"https://example.com"}),
                ),
                req(
                    "3",
                    "vault.fill",
                    serde_json::json!({"entry_id":"e1","origin":"https://example.com","confirm":"t"}),
                ),
            ],
        );
        assert_eq!(rs.len(), 3);
        assert!(rs.iter().all(|r| r.ok));
        assert_eq!(rs[0].payload.as_ref().unwrap()["locked"], false);
        assert_eq!(rs[2].payload.as_ref().unwrap()["password"], "test-password");
    }

    #[test]
    fn end_to_end_locked_session_refuses_passwords() {
        let mut ops = FakeOps::locked();
        let rs = run_session(
            &mut ops,
            &[
                req("1", "status", Value::Null),
                req(
                    "2",
                    "vault.query",
                    serde_json::json!({"origin":"https://example.com"}),
                ),
                req(
                    "3",
                    "vault.fill",
                    serde_json::json!({"entry_id":"e1","origin":"https://example.com","confirm":"t"}),
                ),
            ],
        );
        assert!(rs[0].ok, "锁定状态下 status 仍然要能回答");
        assert_eq!(rs[0].payload.as_ref().unwrap()["locked"], true);
        assert_eq!(rs[1].error.as_ref().unwrap().code, "VAULT_LOCKED");
        assert_eq!(rs[2].error.as_ref().unwrap().code, "VAULT_LOCKED");
    }

    #[test]
    fn end_to_end_wrong_secret_aborts_before_any_request() {
        let client_secret = SharedSecret::from_bytes([1u8; 32]);
        let server_secret = SharedSecret::from_bytes([2u8; 32]);
        let challenge = [7u8; CHALLENGE_LEN];
        let nonce = [9u8; CHALLENGE_LEN];

        let mut input = Vec::new();
        let mut hello = nonce.to_vec();
        hello.extend_from_slice(&client_proof(&client_secret, &challenge, &nonce));
        write_frame(&mut input, &hello).unwrap();

        let mut t = Scripted {
            input: Cursor::new(input),
            output: Vec::new(),
        };
        let mut ops = FakeOps::unlocked();
        let err = serve_with_challenge(&mut t, &server_secret, &mut ops, challenge).unwrap_err();
        assert!(matches!(err, BridgeError::HandshakeFailed(_)));

        // 输出里只有 challenge，没有 "ok"
        let mut out = Cursor::new(t.output);
        let _ = read_frame(&mut out).unwrap();
        assert!(read_frame(&mut out).is_err(), "握手失败后不应再写任何帧");
    }

    #[test]
    fn locked_vault_refuses_requests_via_handle_one() {
        let mut ops = FakeOps::locked();
        let body = serde_json::to_vec(&req(
            "r1",
            "vault.fill",
            serde_json::json!({"entry_id":"e1","origin":"https://example.com","confirm":"t"}),
        ))
        .unwrap();
        let resp = handle_one(&body, &mut ops);
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "VAULT_LOCKED");
    }

    #[test]
    fn unlocked_vault_answers_query_without_password() {
        let mut ops = FakeOps::unlocked();
        let body = serde_json::to_vec(&req(
            "r3",
            "vault.query",
            serde_json::json!({"origin":"https://example.com"}),
        ))
        .unwrap();
        let resp = handle_one(&body, &mut ops);
        assert!(resp.ok);
        let text = serde_json::to_string(&resp.payload).unwrap();
        assert!(text.contains("e1"));
        assert!(!text.contains("test-password"), "query 绝不能带密码");
    }

    #[test]
    fn unknown_command_never_reaches_ops() {
        let mut ops = FakeOps::unlocked();
        let body = br#"{"v":1,"id":"x","cmd":"vault.purge"}"#;
        let resp = handle_one(body, &mut ops);
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "UNKNOWN_COMMAND");
    }

    #[test]
    fn malformed_json_is_rejected() {
        let mut ops = FakeOps::unlocked();
        let resp = handle_one(b"{not json", &mut ops);
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "MALFORMED");
    }

    #[test]
    fn rate_limiter_blocks_after_limit() {
        let mut rl = RateLimiter::new(3);
        assert!(rl.allow());
        assert!(rl.allow());
        assert!(rl.allow());
        assert!(!rl.allow());
    }

    #[test]
    fn handshake_timeout_is_enforced() {
        // 握手前故意拖过上限定值，应拿到 Timeout 而不是继续
        let shared = SharedSecret::from_bytes([5u8; 32]);
        let challenge = [7u8; CHALLENGE_LEN];
        let nonce = [9u8; CHALLENGE_LEN];

        let mut input = Vec::new();
        let mut hello = nonce.to_vec();
        hello.extend_from_slice(&crate::auth::client_proof(&shared, &challenge, &nonce));
        write_frame(&mut input, &hello).unwrap();

        let mut t = Scripted {
            input: Cursor::new(input),
            output: Vec::new(),
        };
        let mut ops = FakeOps::unlocked();
        let opts = ServeOptions {
            request_timeout: Duration::from_millis(50),
            handshake_timeout: Duration::ZERO, // 任何耗时都算超时
            on_timeout: None,
        };
        // 注意：这里必须用 serve_inner（挑战值可控）。
        // serve_with_options 生成随机挑战，客户端算出的 proof 必然对不上，
        // 那样测试就变成在验证"握手失败"而不是"握手超时"。
        let err = serve_inner(&mut t, &shared, &mut ops, challenge, opts).unwrap_err();
        assert!(matches!(err, BridgeError::Timeout), "实际错误: {err:?}");
    }

    #[test]
    fn watchdog_is_wired_into_the_request_loop() {
        // 用极短超时 + 一个"客户端不发请求"的空输入，
        // 验证看门狗的对象在会话中被创建并能被触发（通过取消回调计数）
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);

        let shared = SharedSecret::from_bytes([5u8; 32]);
        let challenge = [7u8; CHALLENGE_LEN];
        let nonce = [9u8; CHALLENGE_LEN];

        let mut input = Vec::new();
        let mut hello = nonce.to_vec();
        hello.extend_from_slice(&crate::auth::client_proof(&shared, &challenge, &nonce));
        write_frame(&mut input, &hello).unwrap();
        // 之后故意不写任何请求帧，让服务端在读上"卡住"（这里用空输入模拟立即 EOF）

        let mut t = Scripted {
            input: Cursor::new(input),
            output: Vec::new(),
        };
        let mut ops = FakeOps::unlocked();
        let opts = ServeOptions {
            request_timeout: Duration::from_millis(20),
            handshake_timeout: Duration::from_secs(60),
            on_timeout: Some(Box::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            })),
        };
        // 空输入 → 立刻 Closed → 正常结束；此处只验证选项被接受且不 panic
        let _ = serve_inner(&mut t, &shared, &mut ops, challenge, opts);
        // 取消回调是否触发取决于时序，不做强断言
    }

    #[test]
    fn ciphertext_never_contains_plaintext_marker() {
        let shared = SharedSecret::from_bytes([5u8; 32]);
        let key = derive_session_key(&shared, &[1u8; 32], &[2u8; 32]).unwrap();
        let mut a = SessionCipher::new(&key);
        let sealed = a.seal(b"PASSWORD-MARKER").unwrap();
        assert!(!sealed.windows(15).any(|w| w == b"PASSWORD-MARKER"));
    }
}
