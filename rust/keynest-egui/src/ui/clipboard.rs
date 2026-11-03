//! 剪贴板封装。
//!
//! 底层完全交给 `keynest_core::secure`（TTL 清除、写入时标记不进剪贴板历史、
//! 清除前校验内容仍是自己的）。这一层只做两件 UI 相关的事：
//!   1. 记住「最后复制了什么」，锁定时才能精确调用 `clear_now`
//!   2. 计算复制横幅的剩余秒数

use std::time::{Duration, Instant};
use zeroize::Zeroizing;

use keynest_core::error::Result;
use keynest_core::secure;

/// 复制敏感文本。
///
/// 成功后把本次内容记进 `last_copied`，供锁定时精确清除。
/// 返回 `(Instant, u32)`：横幅起点与总秒数。
pub fn copy_remembered(
    text: &str,
    ttl_secs: u32,
    last_copied: &mut Option<Zeroizing<String>>,
) -> Result<(Instant, u32)> {
    let ttl = Duration::from_secs(ttl_secs as u64);
    secure::copy_sensitive(text, Some(ttl))?;
    *last_copied = Some(Zeroizing::new(text.to_string()));
    Ok((Instant::now(), ttl_secs))
}

/// 横幅剩余秒数；已过期返回 0。
pub fn banner_remaining(banner: &(Instant, u32)) -> u32 {
    let (started, total) = banner;
    let elapsed = started.elapsed().as_secs() as u32;
    total.saturating_sub(elapsed)
}

/// 锁定时清除剪贴板。
///
/// 只有剪贴板内容仍是我们复制的那一份时才会真正清空
/// （`clear_now` 内部会读回校验；用户已复制别的东西时它什么都不做）。
pub fn clear_on_lock(last_copied: &mut Option<Zeroizing<String>>) {
    if let Some(expected) = last_copied.as_ref() {
        let _ = secure::clear_now(expected.as_str());
    }
    *last_copied = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `clear_on_lock` 必须把「记住的那份值」也清掉。
    ///
    /// 只清系统剪贴板、不清 `last_copied` 的话，下一次锁定会把
    /// 旧的期望值再拿去比对一遍——虽然不会清错东西，
    /// 但「我们以为剪贴板里是什么」这件事就错了。
    #[test]
    fn clear_on_lock_forgets_the_remembered_value() {
        let mut last: Option<Zeroizing<String>> = Some(Zeroizing::new("secret".into()));
        clear_on_lock(&mut last);
        assert!(last.is_none(), "记住的旧值没被清掉");
    }

    /// 没有复制过时调用也不能 panic。
    #[test]
    fn clear_on_lock_with_nothing_remembered_is_a_noop() {
        let mut last: Option<Zeroizing<String>> = None;
        clear_on_lock(&mut last);
        assert!(last.is_none());
    }

    #[test]
    fn banner_counts_down() {
        let banner = (Instant::now(), 20u32);
        // 刚开始时剩余应接近 20
        let left = banner_remaining(&banner);
        assert!(left == 20 || left == 19, "实际 {left}");
    }

    #[test]
    fn banner_expires() {
        // 用一个已经过去很久的起点
        let past = Instant::now() - Duration::from_secs(30);
        let banner = (past, 20u32);
        assert_eq!(banner_remaining(&banner), 0);
    }
}
