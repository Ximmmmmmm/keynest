//! `keynest-native-host`：浏览器与 KeyNest 之间的中继进程。
//!
//! ```text
//! stdin  ──明文帧──► 加密 ──► 管道 ──► GUI
//! stdout ◄─明文帧──  解密 ◄──管道 ◄── GUI
//! ```
//!
//! # 它做什么 / 不做什么
//!
//! **做**：与 GUI 完成认证握手（HMAC-SHA256），派生会话密钥（HKDF），
//! 然后对**两个方向**做 XChaCha20-Poly1305 加解密。
//!
//! **不做**：不解析命令、不解密密码库、不认主密码。
//!
//! # 为什么必须参与加密
//!
//! GUI 侧 `serve` 期待的是「challenge → proof → ok → 加密帧」。
//! 如果 Host 只做透明转发，GUI 会把明文的浏览器帧当成握手应答解析，
//! 长度不符 → HandshakeFailed → 连接断开 → 浏览器拿到 TIMEOUT。
//! 这是阶段 1 遗留的架构缺口，真实 Chrome 测试才暴露出来。

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use keynest_bridge::auth::{client_proof, derive_session_key, SessionCipher, SharedSecret};
use keynest_bridge::framing::{read_frame, write_frame};
use keynest_bridge::pipe::connect_client;
use keynest_bridge::BridgeError;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(BridgeError::Closed) => ExitCode::SUCCESS,
        Err(e) => {
            // 只写错误码，绝不写消息内容
            let _ = writeln!(io::stderr(), "keynest-native-host: {}", e.code());
            ExitCode::FAILURE
        }
    }
}

/// 定位共享密钥所在目录。
///
/// **直接调用 `keynest-paths`，不再自己写一份**：GUI 与 Host 是两个进程，
/// 只要两边逻辑有一丁点差异，就会读到不同的 `bridge.key`，
/// 握手永久失败且现象只是 `HANDSHAKE`——阶段 2.6 为此查了很久。
fn data_dir() -> PathBuf {
    keynest_paths::resolve_data_dir()
}

fn load_secret() -> Result<SharedSecret, BridgeError> {
    let dir = data_dir();
    match keynest_bridge::keyfile::load(&dir)? {
        Some(s) => Ok(s),
        None => Err(BridgeError::HandshakeFailed(
            "找不到 bridge.key（GUI 未解锁过？）",
        )),
    }
}

fn run() -> Result<(), BridgeError> {
    // 先连 GUI：连不上要让浏览器显示"扩展未连接"。
    //
    // # 但不能只是"立刻退出"
    //
    // 宿主没安装 与 宿主在但桌面程序没跑，这两件事在扩展那边
    // **看起来一模一样**：Chrome 找不到宿主时，`connectNative` 不抛错，
    // 只是返回一个立即断开的端口。
    //
    // 扩展因此分不清「该去装桥接」还是「该去开钥巢」——
    // 而用户看到的是同一句话。���是扩展第一次装上时最常遇到的情况，
    // 引导给错方向，用户就会得出「这软件有问题」的结论。
    //
    // 所以这里先把原因告诉扩展，再退出。
    let mut pipe = match connect_client() {
        Ok(p) => p,
        Err(e) => {
            // 注意：这条消息走的是**浏览器 → 扩展**的方向（stdout），
            // 所以扩展能收到它，并据此给出正确的引导。
            let boot = br#"{"v":1,"id":"__boot__","ok":false,"error":"GUI_NOT_RUNNING"}"#;
            let _ = write_frame(&mut io::stdout(), boot);
            // 给扩展一点时间把这个消息送到——写完立刻退出会让扩展
            // 先收到「断开」再收到「原因」，顺序反了它就分不清了。
            std::thread::sleep(std::time::Duration::from_millis(800));
            let _ = e;
            return Ok(());
        }
    };
    let shared = load_secret()?;

    // ---- 握手：challenge → proof → ok ----
    let challenge_frame = read_frame(&mut pipe)?;
    let n = keynest_bridge::limits::CHALLENGE_LEN;
    if challenge_frame.len() != n {
        return Err(BridgeError::HandshakeFailed("challenge 长度不符"));
    }
    let mut challenge = [0u8; keynest_bridge::limits::CHALLENGE_LEN];
    challenge.copy_from_slice(&challenge_frame);

    let client_nonce = keynest_bridge::auth::random_challenge()?;
    let proof = client_proof(&shared, &challenge, &client_nonce);

    let mut hello = Vec::with_capacity(client_nonce.len() + proof.len());
    hello.extend_from_slice(&client_nonce);
    hello.extend_from_slice(&proof);
    write_frame(&mut pipe, &hello)?;

    let ack = read_frame(&mut pipe)?;
    if ack != b"ok" {
        return Err(BridgeError::HandshakeFailed("GUI 拒绝了握手"));
    }

    let key = derive_session_key(&shared, &challenge, &client_nonce)?;
    let mut to_gui = SessionCipher::new(&key);
    let mut from_gui = SessionCipher::new(&key);

    // ---- 双向转发 ----
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let from_browser = match read_frame(&mut stdin) {
            Ok(f) => f,
            Err(BridgeError::Closed) => return Ok(()),
            Err(e) => return Err(e),
        };

        // 浏览器 → GUI：加密后送管道
        let sealed = to_gui.seal(&from_browser)?;
        write_frame(&mut pipe, &sealed)?;

        // GUI → 浏览器：读密文、解密、原样写给 stdout
        let sealed_back = read_frame(&mut pipe)?;
        let plain = from_gui.open(&sealed_back)?;
        write_frame(&mut stdout, &plain)?;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn binary_has_no_password_logging() {
        // 静态检查：本文件不得出现把消息内容写进标准输出的调用。
        let src = include_str!("native_host.rs");
        let needles = [
            format!("print{}", "ln!"),
            format!("pr{}!", "int"),
            format!("d{}!", "bg"),
        ];
        for bad in needles {
            assert!(
                !src.contains(&bad),
                "native host 不应使用 {bad}，否则可能把消息内容写进日志"
            );
        }
    }
}
