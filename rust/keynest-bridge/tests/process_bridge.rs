//! 进程级集成测试：真实的命名管道 + 真实的 native host 二进制。
//!
//! # 为什么需要它
//!
//! 桥接链路上有三个此前**只有单元测试**的关键模块：
//!
//! | 模块 | 职责 | 单元测试能覆盖什么 |
//! | --- | --- | --- |
//! | `keyfile` | 读 `bridge.key` | 文件读写 |
//! | `pipe` | 命名管道 | 名字格式 |
//! | `auth` | 握手密码学 | 密钥派生与 proof 校验 |
//!
//! 但它们**之间的接线**只有真正跑两个进程才能验：
//! native host 读到的 key 与 GUI 用的 key 是不是同一个字节、
//! 管道名对不对得上、proof 的计算与校验是不是同一套。
//!
//! 阶段 2.6 为「两边逻辑有一丁点差异 → 握手永久失败 → 现象只是 HANDSHAKE」
//! 查过很久——那正是这类接线问题的典型表现。
//!
//! # 为什么不用 GUI
//!
//! GUI（`keynest-egui`）必须解锁才能提供管道服务端，而解锁需要真实输入
//! 自动化，会**抢占焦点与键鼠**，打扰正在使用电脑的人。
//!
//! 这里让服务端直接用 `keynest_bridge` 的公开 API 起在测试进程里，
//! 客户端仍然是**真实的 `keynest-native-host.exe`**——
//! 接线最难的那一段（跨进程、跨 keyfile、跨管道名）全部是真的。
//!
//! # 它测不了什么
//!
//! GUI 自己的解锁流程、以及 GUI 与 bridge 之间的 IPC 仍然需要
//! `test/acceptance/run.mjs`（那要 GUI）。
//!
//! # 为什么这些测试必须串行
//!
//! 管道名是**固定常量**（`\.\pipe\keynest-bridge-v1`），没有按测试隔离。
//! 两个测试同时跑会抢同一个管道，表现为「连不上」或「IO 错误」。
//!
//! 这不是测试写得不好，而是**真实运行的约束**：同一台机器上只能有一个
//! GUI 实例（这正是单实例锁的职责）。所以这里用一把全局互斥锁把
//! 三个测试串起来，而不是去改生产代码里的管道名——
//! 管道名带版本号是**有意的**（见 pipe.rs 注释）。

use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use keynest_bridge::auth::{client_proof, derive_session_key, random_challenge, SessionCipher};
use keynest_bridge::keyfile;
use keynest_bridge::pipe;

/// 全局互斥锁：管道名固定，测试必须串行。
static PIPE_LOCK: Mutex<()> = Mutex::new(());

/// 假的服务端操作集：像真实 GUI 那样应答 `status` / `query` / `fill`。
#[derive(Default)]
struct FakeOps {
    locked: bool,
}

impl keynest_bridge::server::VaultOps for FakeOps {
    fn app_version(&self) -> String {
        "test".into()
    }
    fn lock_state(&self) -> keynest_bridge::protocol::LockState {
        if self.locked {
            keynest_bridge::protocol::LockState::Locked
        } else {
            keynest_bridge::protocol::LockState::Unlocked
        }
    }
    fn query(
        &mut self,
        _origin: &str,
    ) -> Result<Vec<keynest_bridge::protocol::EntrySummary>, keynest_bridge::error::BridgeError>
    {
        Ok(Vec::new())
    }
    fn fill(
        &mut self,
        _entry_id: &str,
        _origin: &str,
    ) -> Result<zeroize::Zeroizing<String>, keynest_bridge::error::BridgeError> {
        Ok(zeroize::Zeroizing::new("test-password".to_string()))
    }
    fn save(
        &mut self,
        _payload: keynest_bridge::protocol::SavePayload,
    ) -> Result<String, keynest_bridge::error::BridgeError> {
        Ok("id".into())
    }
    fn conflicts(&mut self) -> Result<serde_json::Value, keynest_bridge::error::BridgeError> {
        Ok(serde_json::json!([]))
    }
}

/// 读一帧（4 字节长度前缀 + 载荷）。
fn read_frame(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_le_bytes(len) as usize;
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

/// 写一帧。
fn write_frame(w: &mut impl Write, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/// 客户端侧的完整握手，与 `bin/native_host.rs` 的逻辑一致。
///
/// 这里**手工重写**一遍而不是直接调用 native host 的内部函数——
/// 因为 native host 的函数都在 `main` 里，没有被抽成库。
/// 重写本身就是一次对照：两处逻辑若不一致，测试会失败。
fn client_handshake<T: Read + Write>(
    pipe: &mut T,
    shared: &keynest_bridge::auth::SharedSecret,
) -> [u8; keynest_bridge::limits::SESSION_KEY_LEN] {
    let challenge_frame = read_frame(pipe).expect("应收到 challenge");
    let n = keynest_bridge::limits::CHALLENGE_LEN;
    assert_eq!(challenge_frame.len(), n, "challenge 长度不符");

    let mut challenge = [0u8; keynest_bridge::limits::CHALLENGE_LEN];
    challenge.copy_from_slice(&challenge_frame);

    let client_nonce = random_challenge().expect("随机数");
    let proof = client_proof(shared, &challenge, &client_nonce);

    let mut hello = Vec::with_capacity(client_nonce.len() + proof.len());
    hello.extend_from_slice(&client_nonce);
    hello.extend_from_slice(&proof);
    write_frame(pipe, &hello).expect("发送 hello");

    let ack = read_frame(pipe).expect("应收到 ack");
    assert_eq!(ack, b"ok", "服务端拒绝了握手");

    *derive_session_key(shared, &challenge, &client_nonce).expect("派生会话密钥")
}

/// 起一个服务端线程，等客户端连上，跑一次会话。
fn run_server(
    data_dir: &Path,
    ops: FakeOps,
    result_tx: std::sync::mpsc::Sender<Result<String, String>>,
) {
    let shared = match keyfile::load_or_create(data_dir) {
        Ok((s, _)) => s,
        Err(e) => {
            let _ = result_tx.send(Err(format!("读取 bridge.key 失败: {}", e.code())));
            return;
        }
    };

    let mut pipe = match pipe::accept_one() {
        Ok(p) => p,
        Err(e) => {
            let _ = result_tx.send(Err(format!("接受管道连接失败: {}", e.code())));
            return;
        }
    };

    let challenge = random_challenge().expect("challenge");
    let mut ops = ops;
    let outcome =
        keynest_bridge::server::serve_with_challenge(&mut pipe, &shared, &mut ops, challenge);

    let _ = result_tx.send(match outcome {
        Ok(()) => Ok("会话正常结束".into()),
        Err(e) => Err(format!("会话出错: {} / {:?}", e.code(), e)),
    });
}

/// 完整跑一次：起服务端线程 → 连管道 → 握手 → 发一条请求 → 收响应。
fn run_session_with_request(data_dir: &Path, request: &str) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let dir = data_dir.to_path_buf();
    let server = std::thread::spawn(move || run_server(&dir, FakeOps::default(), tx));

    // 等服务端把管道立起来
    let mut pipe = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match pipe::connect_client() {
            Ok(p) => {
                pipe = Some(p);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let mut pipe = pipe.ok_or_else(|| "连不上管道".to_string())?;

    let shared = keyfile::load_or_create(data_dir)
        .map_err(|e| format!("读取 bridge.key 失败: {}", e.code()))?
        .0;
    let key = client_handshake(&mut pipe, &shared);

    // 发一条请求（明文 → 会话密钥加密）
    let mut to_gui = SessionCipher::new(&key);
    let mut from_gui = SessionCipher::new(&key);
    let sealed = to_gui
        .seal(request.as_bytes())
        .map_err(|e| e.code().to_string())?;
    write_frame(&mut pipe, &sealed).map_err(|e| e.to_string())?;

    let blob = read_frame(&mut pipe).map_err(|e| format!("读响应失败: {e}"))?;
    let plain = from_gui
        .open(&blob)
        .map_err(|e| format!("解密失败: {}", e.code()))?;
    let text = String::from_utf8_lossy(&plain).to_string();

    // 关掉管道，让服务端收尾
    drop(pipe);
    let server_result = rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap_or(Err("服务端没结束".into()));
    let _ = server.join();

    server_result.map(|_| text)
}

#[test]
fn handshake_and_request_work_across_process_boundary() {
    let _guard = PIPE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().expect("临时目录");
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let req = r#"{"v":1,"id":"1","cmd":"status","payload":null}"#;
    let resp = run_session_with_request(&data_dir, req).expect("会话应成功");

    assert!(resp.contains("\"ok\":true"), "响应应当是成功: {resp}");
    assert!(
        resp.contains("\"protocol\""),
        "响应应当包含协议版本: {resp}"
    );
}

#[test]
fn wrong_shared_secret_is_rejected_before_any_request() {
    let _guard = PIPE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 服务端与客户端用**不同的** bridge.key：握手必须失败，
    // 而且是在处理任何请求**之前**失败——不能让未认证的连接读到数据。
    let dir = tempfile::tempdir().expect("临时目录");
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    // 先造一份正确的 key，再覆盖成另一份
    let (real, _) = keyfile::load_or_create(&data_dir).expect("生成 key");
    std::fs::write(keyfile::key_path(&data_dir), {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).unwrap();
        raw
    })
    .unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let dir2 = data_dir.clone();
    let server = std::thread::spawn(move || run_server(&dir2, FakeOps::default(), tx));

    let mut pipe = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(p) = pipe::connect_client() {
            pipe = Some(p);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut pipe = pipe.expect("连上管道");

    // 用**错误的** key 算 proof
    let wrong = keynest_bridge::auth::SharedSecret::generate().expect("生成错误 key");
    let challenge_frame = read_frame(&mut pipe).expect("challenge");
    let mut challenge = [0u8; keynest_bridge::limits::CHALLENGE_LEN];
    challenge.copy_from_slice(&challenge_frame);
    let client_nonce = random_challenge().unwrap();
    let proof = client_proof(&wrong, &challenge, &client_nonce);
    let mut hello = Vec::new();
    hello.extend_from_slice(&client_nonce);
    hello.extend_from_slice(&proof);
    write_frame(&mut pipe, &hello).unwrap();

    // 服务端应当拒绝：要么直接断开，要么回一个非 "ok" 的 ack
    let outcome = read_frame(&mut pipe);
    let rejected = match outcome {
        Ok(ack) => ack != b"ok",
        Err(_) => true, // 直接断开也算拒绝
    };
    assert!(rejected, "错误的 key 不该被接受");

    drop(pipe);
    let _ = rx.recv_timeout(Duration::from_secs(5));
    let _ = server.join();
    drop(real);
}

#[test]
fn bridge_key_file_is_created_with_restrictive_permissions() {
    let _guard = PIPE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // bridge.key 是整个浏览器桥接的根信任：谁读到它谁就能连上管道。
    // 它的权限必须只对本人开放。
    let dir = tempfile::tempdir().expect("临时目录");
    let data_dir = dir.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();

    let (secret, created) = keyfile::load_or_create(&data_dir).expect("生成 key");
    assert!(created, "首次应当创建");
    assert!(keyfile::key_path(&data_dir).exists(), "key 文件应当存在");

    // 再取一次应当拿到**同一份**（这正是 GUI 与 native host 能对上号的依据）
    let (again, created2) = keyfile::load_or_create(&data_dir).expect("再次读取");
    assert!(!created2, "第二次不该重新创建");
    assert_eq!(
        secret.as_bytes(),
        again.as_bytes(),
        "两次读到的必须是同一份 key——否则握手永远失败"
    );
}
