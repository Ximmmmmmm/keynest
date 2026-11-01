//! 单实例锁。
//!
//! # 为什么必须有
//!
//! 库是「整库解密 → 改内存 → 整库重加密 → 覆盖文件」的模型。
//! 两个进程同时解锁同一个库时，各自持有**完整的一份明文副本**：
//!
//! ```text
//! A 解锁 → 改条目 1 → 保存            （磁盘 = A 的版本）
//! B 解锁（读的是 A 之前的状态）→ 改条目 2 → 保存
//!                                    磁盘 = B 的版本，A 的修改消失
//! ```
//!
//! 用户不会收到任何提示。对密码管理器来说这是不可接受的失效模式，
//! 所以启动时必须拿到独占锁，拿不到就明确告诉用户「已经在运行」。
//!
//! # 实现
//!
//! 用标准库的 [`std::fs::File::try_lock`]（Rust 1.89 起稳定），
//! Windows 上映射到 `LockFileEx`，进程退出/文件句柄关闭时由操作系统释放，
//! 不会留下「上次崩溃导致永远打不开」的僵尸锁——这正是它优于
//! 「写一个 pid 文件再判断进程是否存活」的地方。
//!
//! 锁文件与库文件放在同一目录：同一个库对应同一把锁，
//! 通过 `KEYNEST_DATA_DIR` 指向不同目录的两份库互不影响。

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// 一个被持有的实例锁。`drop` 时随文件句柄一起释放。
#[derive(Debug)]
pub struct InstanceLock {
    file: File,
    path: PathBuf,
}

impl InstanceLock {
    /// 尝试获取独占锁。
    ///
    /// * `Ok(Some(lock))` —— 拿到了，可以继续启动；
    /// * `Ok(None)` —— 另一个实例正持有它；
    /// * `Err(_)` —— 连锁文件都建不出来（目录不可写等），调用方应当报告而不能静默放行。
    pub fn acquire(path: &Path) -> std::io::Result<Option<Self>> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() && !dir.exists() {
                std::fs::create_dir_all(dir)?;
            }
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;

        match file.try_lock() {
            Ok(()) => Ok(Some(Self {
                file,
                path: path.to_path_buf(),
            })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(e)) => Err(e),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 显式释放（与 `drop` 等价，只是为了调用点可读）。
    pub fn release(self) {
        drop(self);
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        // 显式解锁再关闭，语义更清楚；即便失败，句柄关闭时系统也会释放。
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("vault.lock");

        let first = InstanceLock::acquire(&p).unwrap();
        assert!(first.is_some(), "第一次必须成功");

        let second = InstanceLock::acquire(&p).unwrap();
        assert!(second.is_none(), "第二次必须被拒绝，否则就是丢数据的入口");

        drop(first);

        let third = InstanceLock::acquire(&p).unwrap();
        assert!(third.is_some(), "释放之后应当可以重新获取");
    }

    #[test]
    fn creates_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join("deeper").join("vault.lock");
        let lock = InstanceLock::acquire(&p).unwrap();
        assert!(lock.is_some());
        assert!(p.exists());
    }

    #[test]
    fn lock_file_survives_release() {
        // 锁文件本身留着没关系：判据是操作系统持有的锁，不是文件是否存在。
        // 这样崩溃之后不会因为「残留文件」而永远打不开。
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("vault.lock");
        drop(InstanceLock::acquire(&p).unwrap());
        assert!(p.exists());
        assert!(InstanceLock::acquire(&p).unwrap().is_some());
    }
}
