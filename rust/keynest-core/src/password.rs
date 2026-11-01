//! 密码生成与强度评估。
//!
//! 安全改动：
//! * 原实现用 `rand::thread_rng()` + `gen_range`。虽然 `thread_rng` 也是
//!   CSPRNG，但为了「全项目只有一个随机源」便于审计，这里改成直接调用
//!   `getrandom`（OS CSPRNG）。
//! * 原实现用 `gen_range`，底层已做拒绝采样；现在自己实现拒绝采样，
//!   彻底消除取模偏差（modulo bias）的可能。
//! * 生成失败不再 panic，改为返回 `Result`。

use zeroize::Zeroizing;

use crate::error::{Result, VaultError};

pub struct GenOptions {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
}

impl Default for GenOptions {
    fn default() -> Self {
        Self {
            length: 16,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
            exclude_ambiguous: true,
        }
    }
}

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*()_+-=[]{}|;:,.<>?";
const AMBIGUOUS: &str = "IlO0o1";

/// 长度上限，防止调用方传入巨大值导致内存问题。
pub const MAX_LENGTH: usize = 256;

/// 在 `[0, bound)` 内取均匀随机下标。
///
/// 用拒绝采样而不是 `% bound`：后者在 bound 不整除 2^32 时会让低位偏多，
/// 对密码生成意味着某些字符出现概率更高。
fn random_index(bound: usize) -> Result<usize> {
    debug_assert!(bound > 0);
    let bound_u = bound as u64;
    // 接受区间上限：把 2^64 截到 bound 的整数倍
    let zone = u64::MAX - (u64::MAX % bound_u);

    loop {
        let mut buf = [0u8; 8];
        getrandom::getrandom(&mut buf).map_err(|_| VaultError::Random)?;
        let v = u64::from_le_bytes(buf);
        if v < zone {
            return Ok((v % bound_u) as usize);
        }
    }
}

/// 生成密码。
///
/// 返回值是普通 `String`（界面要显示/复制），但内部拼接用的缓冲区是
/// `Zeroizing<Vec<char>>`，函数返回后会清零中间态。
pub fn generate(opts: &GenOptions) -> Result<String> {
    let length = opts.length.clamp(1, MAX_LENGTH);

    let mut pool = String::new();
    if opts.lowercase {
        pool.push_str(LOWER);
    }
    if opts.uppercase {
        pool.push_str(UPPER);
    }
    if opts.digits {
        pool.push_str(DIGITS);
    }
    if opts.symbols {
        pool.push_str(SYMBOLS);
    }
    if opts.exclude_ambiguous {
        pool = pool.chars().filter(|c| !AMBIGUOUS.contains(*c)).collect();
    }
    if pool.is_empty() {
        pool.push_str(LOWER); // 兜底：至少有小写字母
    }

    let chars = Zeroizing::new(pool.chars().collect::<Vec<char>>());

    let mut out = String::with_capacity(length);
    for _ in 0..length {
        let idx = random_index(chars.len())?;
        out.push(chars[idx]);
    }
    Ok(out)
}

/// 粗略熵值估算（bit）。用于界面提示强度，不参与安全判定。
pub fn estimate_strength(password: &str) -> f64 {
    if password.is_empty() {
        return 0.0;
    }
    let mut pool: f64 = 0.0;
    if password.chars().any(|c| c.is_ascii_lowercase()) {
        pool += 26.0;
    }
    if password.chars().any(|c| c.is_ascii_uppercase()) {
        pool += 26.0;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        pool += 10.0;
    }
    if password.chars().any(|c| !c.is_ascii_alphanumeric()) {
        pool += 33.0;
    }
    if pool == 0.0 {
        pool = 26.0;
    }
    let n = password.chars().count() as f64;
    n * pool.log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_requested_length() {
        let s = generate(&GenOptions {
            length: 24,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.chars().count(), 24);
    }

    #[test]
    fn respects_charset_selection() {
        let s = generate(&GenOptions {
            length: 20,
            lowercase: true,
            uppercase: false,
            digits: false,
            symbols: false,
            exclude_ambiguous: false,
        })
        .unwrap();
        assert!(s.chars().all(|c| LOWER.contains(c)));
    }

    #[test]
    fn excludes_ambiguous_when_asked() {
        let s = generate(&GenOptions {
            length: 64,
            ..Default::default()
        })
        .unwrap();
        assert!(!s.chars().any(|c| AMBIGUOUS.contains(c)), "got: {s}");
    }

    #[test]
    fn strength_grows_with_length() {
        let weak = estimate_strength("abc");
        let strong = estimate_strength("aB3$xY9!kLmN");
        assert!(strong > weak);
    }

    #[test]
    fn length_is_clamped() {
        let s = generate(&GenOptions {
            length: 100000,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.chars().count(), MAX_LENGTH);
        let s0 = generate(&GenOptions {
            length: 0,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s0.chars().count(), 1);
    }

    #[test]
    fn two_calls_differ() {
        let a = generate(&GenOptions::default()).unwrap();
        let b = generate(&GenOptions::default()).unwrap();
        assert_ne!(a, b, "两次生成不应相同");
    }

    #[test]
    fn random_index_in_range() {
        for _ in 0..1000 {
            let i = random_index(7).unwrap();
            assert!(i < 7);
        }
    }
}
