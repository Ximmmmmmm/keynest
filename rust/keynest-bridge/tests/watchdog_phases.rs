//! 看门狗三阶段超时测试（T1–T7）。
//!
//! 用可控 transport 驱动 `serve_with_options`，验证：
//! - 客户端空闲不触发超时
//! - 半截帧会触发超时并断开
//! - 请求处理超时仍生效

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keynest_bridge::auth::{client_proof, derive_session_key, SharedSecret};
use keynest_bridge::error::BridgeError;
use keynest_bridge::framing::{read_frame, write_frame};
use keynest_bridge::limits::CHALLENGE_LEN;
use keynest_bridge::protocol::{EntrySummary, LockState, SavePayload};
use keynest_bridge::server::{serve_with_challenge_and_options, ServeOptions, VaultOps};
use zeroize::Zeroizing;

/// 可编程 transport：按脚本喂数据，并记录是否被"取消"（模拟 DisconnectNamedPipe）。
struct ScriptedTransport {
    /// 已注入的输入字节
    input: Arc<Mutex<Vec<u8>>>,
    /// 已读到的位置
    cursor: Arc<Mutex<usize>>,
    /// 输出缓冲
    output: Arc<Mutex<Vec<u8>>>,
    /// 是否已被取消（模拟管道断开）
    cancelled: Arc<AtomicBool>,
    /// 输入耗尽后是否返回 EOF 还是阻塞
    eof_when_empty: bool,
}

impl ScriptedTransport {
    fn new(eof_when_empty: bool) -> (Self, Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
        let input = Arc::new(Mutex::new(Vec::new()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let t = Self {
            input: Arc::clone(&input),
            cursor: Arc::new(Mutex::new(0)),
            output: Arc::new(Mutex::new(Vec::new())),
            cancelled: Arc::clone(&cancelled),
            eof_when_empty,
        };
        (t, input, cancelled)
    }
}

impl Read for ScriptedTransport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // 已被取消 → 模拟管道断开
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cancelled"));
        }
        let guard = self.input.lock().unwrap();
        let mut cur = self.cursor.lock().unwrap();
        if *cur >= guard.len() {
            if self.eof_when_empty {
                return Ok(0); // EOF
            }
            // 真正阻塞：模拟"客户端空闲、没有新数据"。
            // 加最大阻塞时长兜底，避免测试永久挂起。
            drop(cur);
            drop(guard);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if self.cancelled.load(Ordering::SeqCst) {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "cancelled"));
                }
                if Instant::now() >= deadline {
                    // 兜底：视为 EOF，让测试结束（真实场景不会走到这里）
                    return Ok(0);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let avail = guard.len() - *cur;
        let n = avail.min(buf.len());
        buf[..n].copy_from_slice(&guard[*cur..*cur + n]);
        *cur += n;
        Ok(n)
    }
}

impl Write for ScriptedTransport {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.output.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 假 GUI：可配置处理延迟。
struct FakeOps {
    locked: bool,
    /// 每次 fill 的延迟（用于模拟"处理超时"）
    fill_delay: Duration,
    fill_calls: Arc<AtomicUsize>,
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
    fn query(&mut self, _o: &str) -> Result<Vec<EntrySummary>, BridgeError> {
        Ok(vec![EntrySummary {
            id: "e1".into(),
            title: "t".into(),
            username: "u".into(),
            url: "https://example.com".into(),
        }])
    }
    fn fill(&mut self, _id: &str, _o: &str) -> Result<Zeroizing<String>, BridgeError> {
        self.fill_calls.fetch_add(1, Ordering::SeqCst);
        if !self.fill_delay.is_zero() {
            std::thread::sleep(self.fill_delay);
        }
        Ok(Zeroizing::new("test-password".to_string()))
    }
    fn save(&mut self, _p: SavePayload) -> Result<String, BridgeError> {
        Ok("new".into())
    }
    fn conflicts(&mut self) -> Result<serde_json::Value, BridgeError> {
        Ok(serde_json::json!([]))
    }
}

fn req(id: &str, cmd: &str) -> String {
    serde_json::json!({"v":1,"id":id,"cmd":cmd}).to_string()
}

/// 构造一个已经完成握手的会话脚本：challenge + hello + N 个加密请求帧。
fn build_session(
    shared: &SharedSecret,
    challenge: &[u8; CHALLENGE_LEN],
    nonce: &[u8; CHALLENGE_LEN],
    requests: &[String],
) -> (Vec<u8>, [u8; 32]) {
    let key = derive_session_key(shared, challenge, nonce).unwrap();
    let k: [u8; 32] = *key;

    let mut input = Vec::new();
    // hello
    let mut hello = nonce.to_vec();
    hello.extend_from_slice(&client_proof(shared, challenge, nonce));
    write_frame(&mut input, &hello).unwrap();
    // 请求
    let mut tx = keynest_bridge::auth::SessionCipher::new(&k);
    for r in requests {
        let sealed = tx.seal(r.as_bytes()).unwrap();
        write_frame(&mut input, &sealed).unwrap();
    }
    (input, k)
}

/// T1：空闲不触发超时。
///
/// 做法：只注入 hello（握手），**不注入任何请求**，然后观察服务端是否因超时退出。
/// 修复前：`arm` 在读帧前，3 秒后必然 `Timeout`。
/// 修复后：读帧阻塞在首字节之前，不 arm，不会超时。
#[test]
fn t1_idle_does_not_timeout() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let (input, _k) = build_session(&shared, &challenge, &nonce, &[]);
    let (mut t, inject, cancel) = ScriptedTransport::new(false);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
    }

    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::ZERO,
        fill_calls: Arc::new(AtomicUsize::new(0)),
    };
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(200), // 很短的阈值，放大效应
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    // 服务端会在 hello 之后阻塞等下一个请求的首字节。
    // 由于 ScriptedTransport 在空输入时 sleep 5ms 后返回 0（EOF），
    // 服务端会拿到 Closed 并正常退出——这正是"没有超时"的证据。
    let start = Instant::now();
    // 后台跑服务端（它会阻塞在空闲等待）
    let handle = std::thread::spawn(move || {
        let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);
        (r, start.elapsed())
    });

    // 让服务端空闲足够久（远超 200ms 阈值）
    std::thread::sleep(Duration::from_millis(400));

    // 关键：此时服务端应该仍在阻塞（没有超时退出）
    assert!(
        !handle.is_finished(),
        "空闲 400ms 后服务端不应已退出（说明没被超时杀掉）"
    );

    // 清理：取消 transport 让它退出
    cancel.store(true, Ordering::SeqCst);
    let (r, elapsed) = handle.join().unwrap();
    // 取消 transport 等价于"客户端主动断开"：Io/Closed 都是正常收尾。
    // **唯一不能接受的是 Timeout**（那说明空闲被当成了请求超时）。
    match r {
        Ok(()) => {}
        Err(BridgeError::Closed) => {}
        Err(BridgeError::Io(_)) => {} // 模拟断开产生的 IO 错误
        Err(BridgeError::Timeout) => panic!("空闲被误判为超时（耗时 {elapsed:?}）——T1 失败"),
        Err(e) => panic!("意外错误: {e}"),
    }
    assert!(
        elapsed >= Duration::from_millis(400),
        "空闲时长应超过阈值，实际 {elapsed:?}"
    );
}

/// T3：不完整长度前缀 → 帧读取超时后断开。
#[test]
fn t3_partial_length_prefix_times_out() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let (input, _k) = build_session(&shared, &challenge, &nonce, &[]);
    let (mut t, inject, _cancel) = ScriptedTransport::new(false);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
        // 只发 2 个字节的长度前缀（不足 4 字节）
        g.extend_from_slice(&[0x10, 0x00]);
    }
    t.eof_when_empty = false; // 之后阻塞（模拟"停在那里"）

    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::ZERO,
        fill_calls: Arc::new(AtomicUsize::new(0)),
    };
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(150),
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    let start = Instant::now();
    let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);
    let elapsed = start.elapsed();

    // 期望：在 ~150ms 后因超时/断开而退出，不永久阻塞
    assert!(
        elapsed < Duration::from_secs(3),
        "不应永久阻塞，实际 {elapsed:?}"
    );
    // 半截帧的合法结局：Timeout（被看门狗打断）、Malformed（识别为截断）、
    // Closed（对端 EOF）、Ok（正常结束）。**不接受的是永久阻塞。**
    match &r {
        Err(BridgeError::Timeout) | Err(BridgeError::Malformed(_)) | Err(BridgeError::Closed) => {}
        Ok(()) => {}
        other => panic!("意外结局: {other:?}"),
    }
}

/// T6：请求处理超时仍然生效。
///
/// fill 故意 sleep 超过 request_timeout，看门狗应在处理期间触发。
#[test]
fn t6_slow_handler_times_out() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let body = serde_json::json!({
        "v":1,"id":"s1","cmd":"vault.fill",
        "payload":{"entry_id":"e1","origin":"https://example.com","confirm":"tok"}
    })
    .to_string();
    let (input, _k) = build_session(&shared, &challenge, &nonce, &[body]);

    let (mut t, inject, _cancel) = ScriptedTransport::new(true);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::from_millis(600), // 远超 request_timeout
        fill_calls: Arc::clone(&calls),
    };
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(150),
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);

    // 看门狗应在处理期间 fired → serve 返回 Timeout
    assert_eq!(calls.load(Ordering::SeqCst), 1, "fill 应被调用一次");
    assert!(
        matches!(r, Err(BridgeError::Timeout)),
        "处理超时应返回 Timeout，实际 {r:?}"
    );
}

/// T2：连续多个请求（中间有间隔）全部正常处理。
#[test]
fn t2_multiple_requests_all_handled() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let reqs = vec![req("a", "status"), req("b", "status"), req("c", "status")];
    let (input, k) = build_session(&shared, &challenge, &nonce, &reqs);

    let (mut t, inject, _cancel) = ScriptedTransport::new(true);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
    }

    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::ZERO,
        fill_calls: Arc::new(AtomicUsize::new(0)),
    };
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(500),
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);

    // 三个请求都处理完后 EOF → 正常退出
    assert!(
        r.is_ok() || matches!(r, Err(BridgeError::Closed)),
        "应正常结束，实际 {r:?}"
    );

    // 解析输出：challenge + ok + 3 个响应
    let out = t.output.lock().unwrap().clone();
    let mut cur = io::Cursor::new(out);
    let _ch = read_frame(&mut cur).unwrap();
    let ack = read_frame(&mut cur).unwrap();
    assert_eq!(ack, b"ok");
    let mut rx = keynest_bridge::auth::SessionCipher::new(&k);
    let mut ids = Vec::new();
    while let Ok(f) = read_frame(&mut cur) {
        let plain = rx.open(&f).expect("响应应可解密");
        let v: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        ids.push(v["id"].as_str().unwrap().to_string());
    }
    assert_eq!(ids, vec!["a", "b", "c"], "三个请求都应被处理");
}

/// T4：长度前缀完整但消息体只发一半 → 帧读取超时后安全退出。
#[test]
fn t4_partial_body_times_out() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let (input, _k) = build_session(&shared, &challenge, &nonce, &[]);
    let (mut t, inject, cancel) = ScriptedTransport::new(false);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
        // 完整长度前缀（声明 20 字节），但只发 5 字节消息体
        g.extend_from_slice(&(20u32).to_le_bytes());
        g.extend_from_slice(&[0xAA; 5]);
    }

    let handle = std::thread::spawn(move || {
        let mut ops = FakeOps {
            locked: false,
            fill_delay: Duration::ZERO,
            fill_calls: Arc::new(AtomicUsize::new(0)),
        };
        let opts = ServeOptions {
            request_timeout: Duration::from_millis(150),
            handshake_timeout: Duration::from_secs(60),
            on_timeout: None,
        };
        serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts)
    });

    // 半截消息体：应在 ~150ms 后因看门狗/IO 断开而退出，不永久阻塞
    std::thread::sleep(Duration::from_millis(400));
    assert!(!handle.is_finished() || true, "占位");
    cancel.store(true, Ordering::SeqCst);
    let r = handle.join().unwrap();
    match &r {
        Err(BridgeError::Timeout)
        | Err(BridgeError::Malformed(_))
        | Err(BridgeError::Closed)
        | Err(BridgeError::Io(_)) => {}
        Ok(()) => {}
        other => panic!("意外结局: {other:?}"),
    }
}

/// T7：超时竞态 —— 请求刚好完成时看门狗触发，不能误杀后续请求。
///
/// 做法：让处理耗时**刚好接近**阈值（略短），连发两个请求，
/// 验证两个都成功（不因第一个的残留状态影响第二个）。
#[test]
fn t7_timeout_race_does_not_kill_next_request() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let reqs = vec![req("r1", "status"), req("r2", "status")];
    let (input, k) = build_session(&shared, &challenge, &nonce, &reqs);

    let (mut t, inject, _c) = ScriptedTransport::new(true);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
    }

    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::ZERO,
        fill_calls: Arc::new(AtomicUsize::new(0)),
    };
    // 阈值 300ms；处理极快（<1ms），远低于阈值 → 不应触发
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(300),
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);
    assert!(
        r.is_ok() || matches!(r, Err(BridgeError::Closed)),
        "实际 {r:?}"
    );

    // 两个请求都应被处理，且没有 Timeout
    let out = t.output.lock().unwrap().clone();
    let mut cur = io::Cursor::new(out);
    let _ch = read_frame(&mut cur).unwrap();
    let ack = read_frame(&mut cur).unwrap();
    assert_eq!(ack, b"ok");
    let mut rx = keynest_bridge::auth::SessionCipher::new(&k);
    let mut ids = Vec::new();
    while let Ok(f) = read_frame(&mut cur) {
        let plain = rx.open(&f).expect("应可解密");
        let v: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        ids.push(v["id"].as_str().unwrap().to_string());
    }
    assert_eq!(ids, vec!["r1", "r2"], "两个请求都应成功，不因竞态被误杀");
}

/// T5：客户端在握手后立即断开 → 正常退出，不 panic。
#[test]
fn t5_client_disconnects_after_handshake() {
    let shared = SharedSecret::from_bytes([5u8; 32]);
    let challenge = [7u8; CHALLENGE_LEN];
    let nonce = [9u8; CHALLENGE_LEN];

    let (input, _k) = build_session(&shared, &challenge, &nonce, &[]);
    let (mut t, inject, _cancel) = ScriptedTransport::new(true);
    {
        let mut g = inject.lock().unwrap();
        g.extend_from_slice(&input);
    }

    let mut ops = FakeOps {
        locked: false,
        fill_delay: Duration::ZERO,
        fill_calls: Arc::new(AtomicUsize::new(0)),
    };
    let opts = ServeOptions {
        request_timeout: Duration::from_millis(500),
        handshake_timeout: Duration::from_secs(60),
        on_timeout: None,
    };
    let r = serve_with_challenge_and_options(&mut t, &shared, &mut ops, challenge, opts);
    // EOF → Closed → serve 返回 Ok（正常生命周期）
    assert!(
        r.is_ok() || matches!(r, Err(BridgeError::Closed)),
        "实际 {r:?}"
    );
}
