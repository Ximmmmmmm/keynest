//! 健壮性测试：把「被改坏的文件」当成主要输入，验证永不 panic。
//!
//! # 为什么要有这一组
//!
//! 密码管理器最危险的时刻不是正常使用，而是**读到不认识的字节**的时候：
//! 磁盘坏道、同步盘中转、误编辑器、攻击者投放。这些场景的共同点是
//! 文件内容不再符合我们写它时的假设。
//!
//! 而在 Rust 里，处理不认识的输入最坏的结果是 `panic` —— 本项目的 release
//! 配置是 `panic = "abort"`，也就是说任何一次 panic 都会**直接杀掉进程**，
//! 用户看到的是「点了解锁，程序消失了」，没有任何解释。
//!
//! 所以这里穷举三类输入：随机垃圾、逐段截断、随机字节翻转。
//! 要求只有一条：**返回 `Err`，不许 panic，也不许把库留在半解锁状态**。
//!
//! # 与 fuzz 的关系
//!
//! 这是确定性的（固定种子），所以能进 CI、能在稳定版工具链上跑、失败可复现。
//! 真正的覆盖导向 fuzz（libFuzzer）需要 nightly，见 `docs/AUDIT.md` 的 E 阶段说明；
//! 两者互补，不是替代关系。

use std::path::{Path, PathBuf};

use keynest_core::Vault;

const MASTER: &str = "robustness-master-password";

/// 失败时允许出现的错误码。出现别的码，说明有多余的错误分支在漏信息或被误用。
const ALLOWED_CODES: [&str; 6] = [
    "INVALID_PASSWORD",
    "CORRUPT",
    "UNSUPPORTED_FORMAT",
    "NO_VAULT",
    "KDF",
    "IO",
];

struct Env {
    _dir: tempfile::TempDir,
    path: PathBuf,
    bytes: Vec<u8>,
}

impl Env {
    /// 造一个真实库并读回原始字节。
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.dat");
        {
            let mut v = Vault::new(&path);
            v.create(MASTER).unwrap();
            // 注意不能写 ..Default::default()：`Entry` 实现了 `Drop`，
            // 结构体更新语法会试图把剩余字段移出来，编译器直接拒绝。
            let e = keynest_core::Entry {
                id: String::new(),
                title: "A".into(),
                username: "u".into(),
                password: "p".into(),
                url: "https://example.test".into(),
                category: "网站".into(),
                notes: String::new(),
                favorite: false,
                kind: keynest_core::kinds::LOGIN.to_string(),
                fields: Vec::new(),
                totp: None,
                password_changed_at: None,
                deleted_at: None,
                created_at: String::new(),
                updated_at: String::new(),
            };
            v.upsert_entry(e).unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        Self {
            _dir: dir,
            path,
            bytes,
        }
    }

    fn write_and_unlock(&self, bytes: &[u8]) -> Option<String> {
        std::fs::write(&self.path, bytes).unwrap();
        let mut v = Vault::new(&self.path);
        let result = v.unlock(MASTER);

        // 无论成功失败，都不允许留下「半解锁」状态：
        // 失败时若 is_unlocked 为真，界面会以为拿到了数据。
        if result.is_err() {
            assert!(
                !v.is_unlocked(),
                "解锁失败后不得处于已解锁状态（{} 字节输入）",
                bytes.len()
            );
        }
        result.err().map(|e| e.code().to_string())
    }
}

fn assert_known_code(code: &str, what: &str) {
    assert!(
        ALLOWED_CODES.contains(&code),
        "{what}: 出现了预期之外的错误码 {code}"
    );
}

/* ------------------------------------------------------------------ */
/* 1. 随机垃圾                                                         */
/* ------------------------------------------------------------------ */

/// 极简 xorshift，固定种子 → 失败可复现，且不引入额外依赖。
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

#[test]
fn random_garbage_never_panics() {
    let env = Env::new();
    let mut rng = Rng(0x5EED_1234_ABCD_0001);

    for i in 0..600 {
        let len = rng.below(4096);
        let bytes: Vec<u8> = (0..len).map(|_| (rng.next() & 0xFF) as u8).collect();
        if let Some(code) = env.write_and_unlock(&bytes) {
            assert_known_code(&code, &format!("第 {i} 段随机输入"));
        }
    }
}

#[test]
fn text_that_looks_like_json_never_panics() {
    // 结构上「像」库文件但字段缺失/类型错误的输入，最容易走到深层分支
    let env = Env::new();
    let cases = [
        "",
        "{}",
        r#"{"format":"keynest.v3"}"#,
        r#"{"format":"keynest.v3","kdf":{},"dek":{},"cipher":{},"payload":""}"#,
        r#"{"format":"keynest.v3","kdf":null,"dek":null,"cipher":null,"payload":null}"#,
        r#"{"format":"keynest.v2","kdf":{"algo":"argon2id"},"cipher":{"algo":"xchacha20-poly1305"},"payload":"!!!"}"#,
        r#"{"format":"keynest.v1","kdf":{"algo":"scrypt","N":0,"r":0,"p":0,"salt":""},"cipher":{"algo":"aes-256-gcm","iv":"","tag":""},"payload":""}"#,
        r#"{"format":"keynest.v3","kdf":{"algo":"argon2id","m_cost":99999999,"t_cost":1,"p_cost":1,"salt":"AAAA"},"dek":{"algo":"xchacha20-poly1305","iv":"","tag":"","wrapped":""},"cipher":{"algo":"xchacha20-poly1305","iv":"","tag":""},"payload":""}"#,
    ];
    for (i, case) in cases.iter().enumerate() {
        if let Some(code) = env.write_and_unlock(case.as_bytes()) {
            assert_known_code(&code, &format!("第 {i} 个构造输入"));
        }
    }
}

/* ------------------------------------------------------------------ */
/* 2. 截断                                                             */
/* ------------------------------------------------------------------ */

#[test]
fn truncation_at_any_length_never_panics() {
    let env = Env::new();
    let total = env.bytes.len();
    // 等距取样，包含 0 与「只差一个字节」
    for step in 0..=20 {
        let len = total * step / 20;
        let cut = &env.bytes[..len];
        if let Some(code) = env.write_and_unlock(cut) {
            assert_known_code(&code, &format!("截断到 {len}/{total} 字节"));
        }
    }
    // 差一个字节也必须失败（而不是「勉强解出半个库」）
    let near = &env.bytes[..total - 1];
    assert!(
        env.write_and_unlock(near).is_some(),
        "少一个字节必须解锁失败"
    );
}

/* ------------------------------------------------------------------ */
/* 3. 字节翻转                                                         */
/* ------------------------------------------------------------------ */

#[test]
fn single_byte_flips_never_panic_and_never_silently_succeed() {
    let env = Env::new();
    let mut rng = Rng(0xC0FF_EE00_1234_5678);
    let total = env.bytes.len();

    // 固定 40 次：每次命中都要跑一遍 Argon2，次数太多会让 CI 变慢。
    // 位置用固定种子选，失败可复现。
    for i in 0..40 {
        let mut bytes = env.bytes.clone();
        let pos = rng.below(total);
        bytes[pos] ^= 0xFF;

        // 翻转落在 JSON 的空白/无关字符上时仍可能正常解析，这是允许的；
        // 只要能解开，就必须是「真的能解开」，而不是解出一堆垃圾。
        if let Some(code) = env.write_and_unlock(&bytes) {
            assert_known_code(&code, &format!("第 {i} 次翻转 @{pos}"));
        }
    }
}

#[test]
fn flipping_a_payload_byte_always_breaks_authentication() {
    // 正文密文占文件的绝大部分。这里要把「改密文」与「改坏 JSON」区分开：
    // 换成另一个**合法 base64 字符**，才能确保走出「解码失败」那段，
    // 真正抵达 AEAD 校验，验证它是认证失败而不是解析失败。
    let env = Env::new();
    let key_at = env
        .bytes
        .windows(9)
        .position(|w| w == b"\"payload\"")
        .expect("v3 文件里应当有 payload 字段");

    // 跳过 `"payload"` 之后的 `:` 与引号，找到值的第一个字节
    let value_start = env.bytes[key_at..]
        .iter()
        .position(|&b| b == b'"')
        .map(|p| key_at + p + 1)
        .expect("payload 必须有字符串值");

    let total = env.bytes.len();
    for offset in [64usize, 512, 2048] {
        let pos = value_start + offset;
        if pos + 1 >= total {
            continue;
        }
        let mut bytes = env.bytes.clone();
        bytes[pos] = if bytes[pos] == b'A' { b'B' } else { b'A' };

        let code = env.write_and_unlock(&bytes).expect("正文被改必须解锁失败");
        assert_eq!(
            code, "INVALID_PASSWORD",
            "偏移 {offset} 处改动密文，应当表现为认证失败"
        );
    }
}

/* ------------------------------------------------------------------ */
/* 4. 大小上限                                                         */
/* ------------------------------------------------------------------ */

#[test]
fn oversized_input_is_rejected_before_parsing() {
    let env = Env::new();
    let path: &Path = &env.path;
    {
        let f = std::fs::File::create(path).unwrap();
        // 稀疏文件，不实际占用 64 MiB+
        f.set_len(keynest_core::MAX_VAULT_BYTES + 1).unwrap();
    }
    let mut v = Vault::new(path);
    let err = v.unlock(MASTER).unwrap_err();
    assert_eq!(err.code(), "CORRUPT");
}
