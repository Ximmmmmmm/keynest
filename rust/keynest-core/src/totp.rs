//! TOTP（基于时间的一次性密码），RFC 6238。
//!
//! # 为什么自己写而不引一个 totp crate
//!
//! 计算本身只有三步：HMAC → 动态截断 → 取模。真正的坑在**输入解析**：
//! 用户可能贴进来的是 `otpauth://` URI、带空格的 Base32、小写、带 `=` 补位，
//! 或者少了补位。这些都要小心处理，而且要给出能看懂的报错。
//!
//! 底层原语一律用 RustCrypto 的 `hmac` / `sha1` / `sha2`，没有一行自研密码学。
//!
//! # 关于 SHA-1
//!
//! 这里用 SHA-1 是**规范要求**：RFC 6238 的默认算法是 HMAC-SHA1，
//! 几乎所有认证器 App（Google Authenticator / Microsoft Authenticator / 1Password）
//! 只支持它。SHA-1 在 HMAC 构造下没有已知的实用攻击。
//!
//! 它与「用 SHA-1 保护口令」是两回事——本项目**没有任何**地方拿 SHA-1/MD5 做密码派生。

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

use crate::error::{Result, VaultError};

/// 默认步长（秒）。RFC 6238 推荐 30。
pub const DEFAULT_PERIOD: u64 = 30;
/// 默认位数。
pub const DEFAULT_DIGITS: u32 = 6;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Algorithm {
    #[default]
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    fn as_query(self) -> &'static str {
        match self {
            Algorithm::Sha1 => "SHA1",
            Algorithm::Sha256 => "SHA256",
            Algorithm::Sha512 => "SHA512",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "SHA1" | "" => Some(Algorithm::Sha1),
            "SHA256" => Some(Algorithm::Sha256),
            "SHA512" => Some(Algorithm::Sha512),
            _ => None,
        }
    }
}

/// 一条 TOTP 配置。
#[derive(Clone, Debug)]
pub struct Totp {
    secret: Vec<u8>,
    digits: u32,
    period: u64,
    algorithm: Algorithm,
    /// 展示用：`Issuer: account`，解析不出来就是空串。
    label: String,
}

impl Totp {
    /// 从用户输入解析。接受两种形态：
    ///
    /// * 完整 `otpauth://totp/...?secret=...` URI（从二维码扫出来就是它）
    /// * 裸 Base32 密钥（认证器 App 里"手动输入"那一栏给的东西）
    pub fn parse(input: &str) -> Result<Self> {
        let text = input.trim();
        if text.is_empty() {
            return Err(VaultError::Totp("验证码密钥为空"));
        }

        if text.to_ascii_lowercase().starts_with("otpauth://") {
            Self::parse_uri(text)
        } else {
            let secret = decode_base32(text)?;
            if secret.is_empty() {
                return Err(VaultError::Totp("验证码密钥为空"));
            }
            Ok(Self {
                secret,
                digits: DEFAULT_DIGITS,
                period: DEFAULT_PERIOD,
                algorithm: Algorithm::Sha1,
                label: String::new(),
            })
        }
    }

    fn parse_uri(uri: &str) -> Result<Self> {
        // 只处理 totp，hotp 是计数器式的，语义不同，明确拒绝而不是猜。
        let lower = uri.to_ascii_lowercase();
        if lower.starts_with("otpauth://hotp") {
            return Err(VaultError::Totp("暂不支持 HOTP（计数器式）"));
        }
        if !lower.starts_with("otpauth://totp") {
            return Err(VaultError::Totp("不是 TOTP 链接"));
        }

        let (path, query) = uri
            .split_once('?')
            .ok_or(VaultError::Totp("TOTP 链接缺少参数"))?;

        let label = path
            .trim_start_matches("otpauth://totp/")
            .trim_start_matches("otpauth://TOTP/")
            .split(':')
            .next_back()
            .unwrap_or("")
            .trim()
            .to_string();

        let mut secret = None;
        let mut digits = DEFAULT_DIGITS;
        let mut period = DEFAULT_PERIOD;
        let mut algorithm = Algorithm::Sha1;

        for pair in query.split('&') {
            let Some((k, v)) = pair.split_once('=') else {
                continue;
            };
            let key = k.trim().to_ascii_lowercase();
            let value = v.trim();
            match key.as_str() {
                "secret" => secret = Some(value.to_string()),
                "digits" => {
                    // 非法值直接拒绝，而不是悄悄退回默认——
                    // 悄悄退回会让用户看到的码和服务器期望的不一致，且毫无提示。
                    let n: u32 = value
                        .parse()
                        .map_err(|_| VaultError::Totp("digits 参数非法"))?;
                    if !(6..=8).contains(&n) {
                        return Err(VaultError::Totp("digits 只支持 6–8"));
                    }
                    digits = n;
                }
                "period" => {
                    let n: u64 = value
                        .parse()
                        .map_err(|_| VaultError::Totp("period 参数非法"))?;
                    if n == 0 || n > 3600 {
                        return Err(VaultError::Totp("period 越界"));
                    }
                    period = n;
                }
                "algorithm" => {
                    algorithm =
                        Algorithm::parse(value).ok_or(VaultError::Totp("不支持的摘要算法"))?;
                }
                _ => {}
            }
        }

        let secret = secret.ok_or(VaultError::Totp("TOTP 链接里没有 secret"))?;
        let secret = decode_base32(&secret)?;
        if secret.is_empty() {
            return Err(VaultError::Totp("验证码密钥为空"));
        }

        Ok(Self {
            secret,
            digits,
            period,
            algorithm,
            label,
        })
    }

    pub fn digits(&self) -> u32 {
        self.digits
    }

    pub fn period(&self) -> u64 {
        self.period
    }

    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// 当前时间步还剩几秒。
    pub fn remaining(&self, unix_secs: u64) -> u64 {
        self.period - (unix_secs % self.period)
    }

    /// 生成 `unix_secs` 时刻的验证码。
    pub fn code_at(&self, unix_secs: u64) -> String {
        let counter = unix_secs / self.period;
        let digest = match self.algorithm {
            Algorithm::Sha1 => hmac_sha1(&self.secret, counter),
            Algorithm::Sha256 => hmac_sha256(&self.secret, counter),
            Algorithm::Sha512 => hmac_sha512(&self.secret, counter),
        };
        let value = dynamic_truncate(&digest);
        let modulus = 10u32.pow(self.digits);
        format!("{:0width$}", value % modulus, width = self.digits as usize)
    }

    /// 当前验证码。
    pub fn code_now(&self) -> String {
        self.code_at(now_secs())
    }

    /// 把配置序列化回 `otpauth://` URI，供落盘与导出使用。
    pub fn to_uri(&self) -> String {
        let mut q = format!("secret={}", encode_base32(&self.secret));
        if self.digits != DEFAULT_DIGITS {
            q.push_str(&format!("&digits={}", self.digits));
        }
        if self.period != DEFAULT_PERIOD {
            q.push_str(&format!("&period={}", self.period));
        }
        if self.algorithm != Algorithm::Sha1 {
            q.push_str(&format!("&algorithm={}", self.algorithm.as_query()));
        }
        let label = if self.label.is_empty() {
            "keynest".to_string()
        } else {
            self.label.clone()
        };
        format!("otpauth://totp/{label}?{q}")
    }
}

/// 当前 UNIX 秒。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 三种摘要各写一个具体实现。
///
/// 泛型版本要在 `Hmac<D>` 上凑齐一长串 trait 边界，编译器给出的建议
/// （`CoreProxy` 之类）比代码本身还难读。三个函数各十来行，反而是更清楚的做法。
fn hmac_sha1(key: &[u8], counter: u64) -> Vec<u8> {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha256(key: &[u8], counter: u64) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha512(key: &[u8], counter: u64) -> Vec<u8> {
    let mut mac = Hmac::<Sha512>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// RFC 4226 §5.3 动态截断。
fn dynamic_truncate(digest: &[u8]) -> u32 {
    let offset = (digest[digest.len() - 1] & 0x0F) as usize;
    let bytes = &digest[offset..offset + 4];
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & 0x7FFF_FFFF
}

/* ------------------------------------------------------------------ */
/* Base32（RFC 4648，无补位或带补位都接受）                              */
/* ------------------------------------------------------------------ */

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 解码 Base32。
///
/// 认证器 App 给出的密钥通常是「大写、无补位、每 4 位一组加空格」的形态，
/// 也有的带 `=`。这里全部接受：先去空格、转大写、去掉尾部补位。
fn decode_base32(input: &str) -> Result<Vec<u8>> {
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'-')
        .map(|b| b.to_ascii_uppercase())
        .collect();

    let cleaned: Vec<u8> = cleaned.into_iter().take_while(|b| *b != b'=').collect();

    if cleaned.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(cleaned.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;

    for byte in cleaned {
        let value = ALPHABET
            .iter()
            .position(|c| *c == byte)
            .ok_or(VaultError::Totp("密钥不是合法的 Base32"))? as u32;
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn encode_base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in bytes {
        buffer = (buffer << 8) | *byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1F) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1F) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 附录 B 的官方测试向量（密钥为 ASCII "1234567890..."）。
    const RFC_KEY_20: &[u8] = b"12345678901234567890";
    const RFC_KEY_32: &[u8] = b"12345678901234567890123456789012";
    const RFC_KEY_64: &[u8] = b"1234567890123456789012345678901234567890123456789012345678901234";

    fn totp_with(key: &[u8], digits: u32, algorithm: Algorithm) -> Totp {
        Totp {
            secret: key.to_vec(),
            digits,
            period: 30,
            algorithm,
            label: String::new(),
        }
    }

    #[test]
    fn rfc6238_sha1_vectors() {
        let t = totp_with(RFC_KEY_20, 8, Algorithm::Sha1);
        let vectors = [
            (59u64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ];
        for (time, expected) in vectors {
            assert_eq!(t.code_at(time), expected, "T={time}");
        }
    }

    #[test]
    fn rfc6238_sha256_vectors() {
        let t = totp_with(RFC_KEY_32, 8, Algorithm::Sha256);
        assert_eq!(t.code_at(59), "46119246");
        assert_eq!(t.code_at(1_111_111_109), "68084774");
        assert_eq!(t.code_at(2_000_000_000), "90698825");
    }

    #[test]
    fn rfc6238_sha512_vectors() {
        let t = totp_with(RFC_KEY_64, 8, Algorithm::Sha512);
        assert_eq!(t.code_at(59), "90693936");
        assert_eq!(t.code_at(1_111_111_109), "25091201");
        assert_eq!(t.code_at(2_000_000_000), "38618901");
    }

    #[test]
    fn base32_roundtrip() {
        for sample in [
            &b""[..],
            &b"a"[..],
            &b"ab"[..],
            &b"abc"[..],
            &b"abcd"[..],
            &b"hello world"[..],
            RFC_KEY_20,
        ] {
            let encoded = encode_base32(sample);
            let decoded = decode_base32(&encoded).unwrap();
            assert_eq!(
                decoded,
                sample,
                "样本 {:?}",
                String::from_utf8_lossy(sample)
            );
        }
    }

    #[test]
    fn base32_accepts_spaces_padding_and_lowercase() {
        // 认证器 App 里常见的三种写法，必须都能吃
        let a = decode_base32("JBSWY3DPEHPK3PXP").unwrap();
        let b = decode_base32("jbsw y3dp ehpk 3pxp").unwrap();
        let c = decode_base32("JBSWY3DPEHPK3PXP====").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
        assert_eq!(a, b"Hello!\xDE\xAD\xBE\xEF".to_vec());
    }

    #[test]
    fn base32_rejects_invalid_characters() {
        assert_eq!(
            decode_base32("JBSWY3DP!HPK3PXP").unwrap_err().code(),
            "TOTP"
        );
    }

    #[test]
    fn parses_bare_secret() {
        let t = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(t.digits(), 6);
        assert_eq!(t.period(), 30);
        assert_eq!(t.algorithm(), Algorithm::Sha1);
        assert_eq!(t.label(), "");
    }

    #[test]
    fn parses_otpauth_uri() {
        let uri = "otpauth://totp/GitHub:alice@example.com\
                   ?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60";
        let t = Totp::parse(uri).unwrap();
        assert_eq!(t.digits(), 8);
        assert_eq!(t.period(), 60);
        assert_eq!(t.algorithm(), Algorithm::Sha256);
        assert_eq!(t.label(), "alice@example.com");
    }

    #[test]
    fn rejects_hotp_and_garbage() {
        assert_eq!(
            Totp::parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP")
                .unwrap_err()
                .code(),
            "TOTP"
        );
        assert_eq!(Totp::parse("").unwrap_err().code(), "TOTP");
        assert_eq!(Totp::parse("http://x").unwrap_err().code(), "TOTP");
    }

    #[test]
    fn rejects_out_of_range_parameters() {
        // 非法 digits 必须报错，而不是悄悄退回 6 位
        assert_eq!(
            Totp::parse("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=9")
                .unwrap_err()
                .code(),
            "TOTP"
        );
        assert_eq!(
            Totp::parse("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&period=0")
                .unwrap_err()
                .code(),
            "TOTP"
        );
        assert_eq!(
            Totp::parse("otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")
                .unwrap_err()
                .code(),
            "TOTP"
        );
    }

    #[test]
    fn uri_roundtrip_preserves_parameters() {
        let uri =
            "otpauth://totp/Acme:bob?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA512";
        let t = Totp::parse(uri).unwrap();
        let again = Totp::parse(&t.to_uri()).unwrap();
        assert_eq!(again.digits(), t.digits());
        assert_eq!(again.period(), t.period());
        assert_eq!(again.algorithm(), t.algorithm());
        assert_eq!(again.code_at(1_234_567_890), t.code_at(1_234_567_890));
    }

    #[test]
    fn code_changes_across_time_steps() {
        let t = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        let a = t.code_at(1_000_000_000);
        let b = t.code_at(1_000_000_030);
        assert_ne!(a, b);
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn remaining_counts_down_within_period() {
        let t = Totp::parse("JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!(t.remaining(0), 30);
        assert_eq!(t.remaining(1), 29);
        assert_eq!(t.remaining(29), 1);
        assert_eq!(t.remaining(30), 30);
    }
}
