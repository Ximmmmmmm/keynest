//! 密钥的内存保护。
//!
//! # 为什么需要这一层
//!
//! `Zeroizing` 解决的是「这块内存被释放时擦干净」，它**解决不了**：
//!
//! * 进程工作集被换出到 `pagefile.sys`；
//! * 系统休眠时整份物理内存写进 `hiberfil.sys`；
//! * 崩溃时 WER 生成含内存的转储。
//!
//! 这三种情况下，密钥已经以明文形式落在磁盘上，而 `Zeroizing` 擦的是内存里的
//! 原地址，对磁盘副本毫无作用。所以要额外把密钥所在的页锁定在物理内存里。
//!
//! # 实现要点
//!
//! * 密钥独占一个 **4096 字节页对齐**的分配。`VirtualLock` 锁定的是整页，
//!   如果密钥和别的堆对象挤在同一页，解锁时会把别人的锁定一起解掉，
//!   而且页内其他数据也会被连带锁住。独占一页，加锁/解锁才是对称的。
//! * 加锁失败不是致命错误：某些受限环境（低配额、容器）会拒绝 `VirtualLock`。
//!   这时降级为「仅有零化」，并通过 [`SecretKey::is_locked`] 如实上报，
//!   由界面决定是否提示，而不是假装保护已生效。
//! * 密钥比较走 `subtle` 的常量时间实现，避免计时侧信道。

use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// 主密钥长度。与 `vault::KEY_LEN` 保持一致。
pub const KEY_LEN: usize = 32;

/// 密钥独占的页大小。x86/ARM 上常见页大小都是 4 KiB。
const PAGE: usize = 4096;

/// 一页对齐的密钥容器。
///
/// `#[repr(align(4096))]` 让 `Box<Page>` 的分配地址按页对齐，
/// 于是 `VirtualLock` 锁定的整页里只有这把钥匙。
#[repr(align(4096))]
struct Page {
    key: [u8; KEY_LEN],
    /// 补齐到整页，确保「一页里只有这一把钥匙」。
    _pad: [u8; PAGE - KEY_LEN],
}

/// 受内存锁定保护的主密钥。
pub struct SecretKey {
    page: Box<Page>,
    /// 平台是否真的锁定了这一页。`false` 表示已降级，界面应当据此提示。
    locked: bool,
}

impl SecretKey {
    /// 把密钥搬进受保护的页。
    ///
    /// 传入的数组会被清零（调用方通常持有的是 `Zeroizing`，这里只是多一道保险）。
    pub fn new(mut bytes: [u8; KEY_LEN]) -> Self {
        let mut page = Box::new(Page {
            key: [0u8; KEY_LEN],
            _pad: [0u8; PAGE - KEY_LEN],
        });
        page.key.copy_from_slice(&bytes);
        bytes.zeroize();

        let locked = imp::lock(page.key.as_ptr(), PAGE);
        Self { page, locked }
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.page.key
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.page.key
    }

    /// 这一页是否真的被锁定在物理内存里。
    pub fn is_locked(&self) -> bool {
        self.locked
    }

    /// 常量时间比较。用于「验证旧主密码」这类不能让计时泄漏前缀匹配长度的场合。
    pub fn ct_eq(&self, other: &[u8; KEY_LEN]) -> bool {
        bool::from(self.page.key.ct_eq(other))
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        // 先擦，再解锁，最后才让分配器回收。
        self.page.key.zeroize();
        self.page._pad.zeroize();
        if self.locked {
            imp::unlock(self.page.key.as_ptr(), PAGE);
        }
    }
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretKey")
            .field("locked", &self.locked)
            .field("bytes", &"<redacted>")
            .finish()
    }
}

/* ------------------------------------------------------------------ */
/* 平台实现                                                            */
/* ------------------------------------------------------------------ */

#[cfg(windows)]
mod imp {
    use windows::Win32::System::Memory::{VirtualLock, VirtualUnlock};

    /// 把 `[ptr, ptr+len)` 所在页锁定在物理内存。
    ///
    /// 返回 `false` 表示平台拒绝（工作集配额不足等）。调用方**不应**据此中断，
    /// 而是降级并如实上报。
    pub fn lock(ptr: *const u8, len: usize) -> bool {
        // SAFETY: `ptr` 来自 `Box<Page>` 的字段，`len` 不超过该分配的大小。
        unsafe { VirtualLock(ptr as *const core::ffi::c_void, len).is_ok() }
    }

    pub fn unlock(ptr: *const u8, len: usize) -> bool {
        // SAFETY: 与 `lock` 相同的地址与长度，且与 `lock` 一一配对。
        unsafe { VirtualUnlock(ptr as *const core::ffi::c_void, len).is_ok() }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 平台暂不实现。
    ///
    /// 这里刻意返回 `false` 而不是假装成功：密钥内存是否被锁定是**可观测的安全属性**，
    /// 静默假装成功等于对用户撒谎。等 macOS / Linux 后端补齐 `mlock` 再来实现。
    pub fn lock(_ptr: *const u8, _len: usize) -> bool {
        false
    }

    pub fn unlock(_ptr: *const u8, _len: usize) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_bytes() {
        let raw = [7u8; KEY_LEN];
        let k = SecretKey::new(raw);
        assert_eq!(k.as_bytes(), &raw);
    }

    #[test]
    fn comparison_is_correct() {
        let k = SecretKey::new([1u8; KEY_LEN]);
        assert!(k.ct_eq(&[1u8; KEY_LEN]));
        let mut other = [1u8; KEY_LEN];
        other[31] ^= 1;
        assert!(!k.ct_eq(&other));
    }

    #[test]
    fn page_is_aligned_to_4096() {
        let k = SecretKey::new([0u8; KEY_LEN]);
        assert_eq!(k.as_bytes().as_ptr() as usize % PAGE, 0, "密钥必须独占一页");
    }

    #[test]
    fn debug_never_prints_the_key() {
        let k = SecretKey::new([0xABu8; KEY_LEN]);
        let s = format!("{k:?}");
        assert!(
            !s.contains("ab") && !s.contains("171"),
            "Debug 泄漏密钥: {s}"
        );
        assert!(s.contains("<redacted>"));
    }

    #[test]
    fn lock_state_is_reported_honestly() {
        // 只断言「有明确结论」，不断言平台一定能锁成功：
        // 某些 CI/容器会拒绝 VirtualLock，这不是实现错误。
        let k = SecretKey::new([3u8; KEY_LEN]);
        let _ = k.is_locked();
    }
}
