//! 密码生成与强度评估。与 Node 版 `src/main/password.js` 行为一致。

use rand::Rng;

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

pub fn generate(opts: &GenOptions) -> String {
    let mut pool = String::new();
    if opts.lowercase { pool.push_str(LOWER); }
    if opts.uppercase { pool.push_str(UPPER); }
    if opts.digits { pool.push_str(DIGITS); }
    if opts.symbols { pool.push_str(SYMBOLS); }

    if opts.exclude_ambiguous {
        pool = pool.chars().filter(|c| !AMBIGUOUS.contains(*c)).collect();
    }
    if pool.is_empty() { pool.push_str(LOWER); }

    let chars: Vec<char> = pool.chars().collect();
    let mut rng = rand::thread_rng();
    (0..opts.length)
        .map(|_| chars[rng.gen_range(0..chars.len())])
        .collect()
}

/// 粗略熵值估算（bit）。用于界面提示强度。
pub fn estimate_strength(password: &str) -> f64 {
    if password.is_empty() { return 0.0; }
    let mut pool: f64 = 0.0;
    if password.chars().any(|c| c.is_ascii_lowercase()) { pool += 26.0; }
    if password.chars().any(|c| c.is_ascii_uppercase()) { pool += 26.0; }
    if password.chars().any(|c| c.is_ascii_digit()) { pool += 10.0; }
    if password.chars().any(|c| !c.is_ascii_alphanumeric()) { pool += 33.0; }
    if pool == 0.0 { pool = 26.0; }
    let n = password.chars().count() as f64;
    n * pool.log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_requested_length() {
        let s = generate(&GenOptions { length: 24, ..Default::default() });
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
        });
        assert!(s.chars().all(|c| LOWER.contains(c)));
    }

    #[test]
    fn excludes_ambiguous_when_asked() {
        let s = generate(&GenOptions { length: 40, ..Default::default() });
        assert!(!s.chars().any(|c| AMBIGUOUS.contains(c)), "got: {s}");
    }

    #[test]
    fn strength_grows_with_length() {
        let weak = estimate_strength("abc");
        let strong = estimate_strength("aB3$xY9!kLmN");
        assert!(strong > weak);
    }
}
