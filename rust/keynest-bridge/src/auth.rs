//! 握手与会话加密。
//!
//! # 为什么本地管道还要加密
//!
//! 同一 Windows 用户下的任何进程都能连这条管道。ACL 只挡"别的用户"，
//! 挡不住"同用户的其他程序"。所以认证是必须的；而认证完成后若仍传明文，
//! 任何能挂上管道的进程依然能嗅探到密码。
//!
//! **但这不意味着能防住同用户恶意软件**——它可以读进程内存、可以读密钥文件。
//! 会话加密解决的是"传输路径上被动可读"，不是"本机已被攻破"。
//!
//! # 方案（不自创算法）
//!
//! ```text
//! 1. 服务端 → 客户端：challenge（32 字节 CSPRNG）
//! 2. 客户端 → 服务端：client_nonce（32 字节）+ HMAC-SHA256(shared, challenge‖client_nonce)
//! 3. 双方各自用 HKDF-SHA256 派生会话密钥
//!      salt = challenge‖client_nonce
//!      ikm  = shared secret
//!      info = "keynest-bridge-v1"
//! 4. 之后每条消息：nonce(24B) ‖ XChaCha20-Poly1305 密文，AAD 携带单调序号
//! ```
//!
//! 序号双向独立、严格递增：重复的旧消息直接判为重放。
//! 随机 nonce（24 字节）由 `getrandom` 提供，不存在重用风险。

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::error::BridgeError;
use crate::limits::{CHALLENGE_LEN, NONCE_LEN, SESSION_KEY_LEN};

type HmacSha256 = Hmac<Sha256>;

/// 长期共享密钥。安装时生成，只存在本地文件里。
///
/// 实现 `Zeroize`，离开作用域即擦除。
pub struct SharedSecret(Zeroizing<[u8; 32]>);

impl SharedSecret {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// 随机生成（安装器或首次运行时用）。
    pub fn generate() -> Result<Self, BridgeError> {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).map_err(|_| BridgeError::HandshakeFailed("熵源不可用"))?;
        Ok(Self::from_bytes(raw))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for SharedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 绝不打印内容
        f.write_str("SharedSecret(<redacted>)")
    }
}

/// 生成 32 字节随机挑战。
pub fn random_challenge() -> Result<[u8; CHALLENGE_LEN], BridgeError> {
    let mut out = [0u8; CHALLENGE_LEN];
    getrandom::getrandom(&mut out).map_err(|_| BridgeError::HandshakeFailed("熵源不可用"))?;
    Ok(out)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// 客户端计算应答。顺序固定，不接受调用方自己拼。
pub fn client_proof(
    shared: &SharedSecret,
    challenge: &[u8; CHALLENGE_LEN],
    client_nonce: &[u8; CHALLENGE_LEN],
) -> [u8; 32] {
    let mut msg = Vec::with_capacity(CHALLENGE_LEN * 2);
    msg.extend_from_slice(challenge);
    msg.extend_from_slice(client_nonce);
    hmac_sha256(shared.as_bytes(), &msg)
}

/// 服务端校验应答。**常量时间比较**，避免逐字节时序泄漏。
pub fn verify_proof(
    shared: &SharedSecret,
    challenge: &[u8; CHALLENGE_LEN],
    client_nonce: &[u8; CHALLENGE_LEN],
    proof: &[u8],
) -> Result<(), BridgeError> {
    let expect = client_proof(shared, challenge, client_nonce);
    if expect.len() != proof.len() {
        return Err(BridgeError::HandshakeFailed("应答长度不符"));
    }
    // 手写常量时间比较：只在"全部字节都比过"之后才返回结果
    let mut diff = 0u8;
    for (a, b) in expect.iter().zip(proof.iter()) {
        diff |= a ^ b;
    }
    if diff == 0 {
        Ok(())
    } else {
        Err(BridgeError::HandshakeFailed("身份验证失败"))
    }
}

/// 从握手材料派生会话密钥。
pub fn derive_session_key(
    shared: &SharedSecret,
    challenge: &[u8; CHALLENGE_LEN],
    client_nonce: &[u8; CHALLENGE_LEN],
) -> Result<Zeroizing<[u8; SESSION_KEY_LEN]>, BridgeError> {
    let mut salt = Vec::with_capacity(CHALLENGE_LEN * 2);
    salt.extend_from_slice(challenge);
    salt.extend_from_slice(client_nonce);

    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut okm = [0u8; SESSION_KEY_LEN];
    hk.expand(b"keynest-bridge-v1", &mut okm)
        .map_err(|_| BridgeError::HandshakeFailed("密钥派生失败"))?;
    Ok(Zeroizing::new(okm))
}

/// 一个方向的加密通道。
///
/// 每个方向各一个实例：序号独立，避免双向共用一个计数器时
/// 因并发而互相踩。
pub struct SessionCipher {
    cipher: XChaCha20Poly1305,
    /// 发送方：下一条消息使用的序号
    tx_seq: u64,
    /// 接收方：期望收到的下一序号
    rx_seq: u64,
}

impl std::fmt::Debug for SessionCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionCipher(<redacted>)")
    }
}

impl SessionCipher {
    pub fn new(key: &[u8; SESSION_KEY_LEN]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(key.into()),
            tx_seq: 0,
            rx_seq: 0,
        }
    }

    /// 加密一条消息：`nonce(24) ‖ ciphertext`。
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, BridgeError> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce_bytes).map_err(|_| BridgeError::Io("熵源不可用".into()))?;
        let nonce = XNonce::from_slice(&nonce_bytes);

        let seq = self.tx_seq.to_le_bytes();
        let ct = self
            .cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: &seq,
                },
            )
            .map_err(|_| BridgeError::Io("加密失败".into()))?;

        self.tx_seq = self.tx_seq.checked_add(1).ok_or(BridgeError::Io(
            // 序号溢出意味着这条连接已经跑了 2^64 条消息；
            // 与其静默回绕（会让重放保护失效），不如直接断开重连。
            "会话序号溢出，请重新握手".into(),
        ))?;

        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    /// 解密一条消息，并强制序号严格递增。
    pub fn open(&mut self, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, BridgeError> {
        if blob.len() < NONCE_LEN + 16 {
            return Err(BridgeError::Malformed("加密消息过短"));
        }
        let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
        let nonce = XNonce::from_slice(nonce_bytes);

        let seq = self.rx_seq.to_le_bytes();
        let pt = self
            .cipher
            .decrypt(nonce, Payload { msg: ct, aad: &seq })
            .map_err(|_| BridgeError::Replay)?; // 序号不对或密文被改，一律按重放处理

        self.rx_seq = self
            .rx_seq
            .checked_add(1)
            .ok_or(BridgeError::Io("会话序号溢出，请重新握手".into()))?;
        Ok(Zeroizing::new(pt))
    }
}

/// 一次性把缓冲区擦干净（显式调用点比依赖 Drop 更清楚）。
pub fn wipe(buf: &mut [u8]) {
    buf.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (SessionCipher, SessionCipher) {
        let shared = SharedSecret::from_bytes([7u8; 32]);
        let challenge = [1u8; 32];
        let nonce = [2u8; 32];
        let key = derive_session_key(&shared, &challenge, &nonce).unwrap();
        (SessionCipher::new(&key), SessionCipher::new(&key))
    }

    #[test]
    fn handshake_accepts_correct_proof() {
        let shared = SharedSecret::from_bytes([9u8; 32]);
        let challenge = [3u8; 32];
        let nonce = [4u8; 32];
        let proof = client_proof(&shared, &challenge, &nonce);
        assert!(verify_proof(&shared, &challenge, &nonce, &proof).is_ok());
    }

    #[test]
    fn handshake_rejects_wrong_secret() {
        let good = SharedSecret::from_bytes([9u8; 32]);
        let bad = SharedSecret::from_bytes([8u8; 32]);
        let challenge = [3u8; 32];
        let nonce = [4u8; 32];
        let proof = client_proof(&bad, &challenge, &nonce);
        assert!(verify_proof(&good, &challenge, &nonce, &proof).is_err());
    }

    #[test]
    fn handshake_rejects_tampered_nonce() {
        let shared = SharedSecret::from_bytes([9u8; 32]);
        let challenge = [3u8; 32];
        let nonce = [4u8; 32];
        let proof = client_proof(&shared, &challenge, &nonce);
        let other = [5u8; 32];
        assert!(verify_proof(&shared, &challenge, &other, &proof).is_err());
    }

    #[test]
    fn different_handshakes_derive_different_keys() {
        let shared = SharedSecret::from_bytes([1u8; 32]);
        let k1 = derive_session_key(&shared, &[1u8; 32], &[1u8; 32]).unwrap();
        let k2 = derive_session_key(&shared, &[2u8; 32], &[1u8; 32]).unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn session_roundtrip() {
        let (mut a, mut b) = pair();
        let msg = br#"{"cmd":"status"}"#;
        let sealed = a.seal(msg).unwrap();
        assert_ne!(&sealed[NONCE_LEN..], &msg[..], "密文不得等于明文");
        assert_eq!(b.open(&sealed).unwrap().as_slice(), msg);
    }

    #[test]
    fn replaying_the_same_ciphertext_is_rejected() {
        let (mut a, mut b) = pair();
        let sealed = a.seal(b"hello").unwrap();
        assert!(b.open(&sealed).is_ok());
        // 同一条密文再喂一次：序号已推进，必须判为重放
        assert!(matches!(b.open(&sealed), Err(BridgeError::Replay)));
    }

    #[test]
    fn out_of_order_delivery_is_rejected() {
        let (mut a, mut b) = pair();
        let m1 = a.seal(b"one").unwrap();
        let m2 = a.seal(b"two").unwrap();
        assert!(b.open(&m2).is_err(), "跳过序号必须被拒绝");
        assert!(b.open(&m1).is_ok());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let (mut a, mut b) = pair();
        let mut sealed = a.seal(b"secret").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xFF;
        assert!(b.open(&sealed).is_err());
    }

    #[test]
    fn nonces_are_unique_across_messages() {
        let (mut a, _b) = pair();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let sealed = a.seal(b"x").unwrap();
            let nonce = &sealed[..NONCE_LEN];
            assert!(seen.insert(nonce.to_vec()), "nonce 出现了重复");
        }
    }

    #[test]
    fn secret_is_never_printed() {
        let s = SharedSecret::from_bytes([42u8; 32]);
        let text = format!("{s:?}");
        assert!(text.contains("redacted"));
        assert!(!text.contains("42"));
    }
}
