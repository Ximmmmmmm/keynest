//! 数据目录解析（**转发层**）。
//!
//! 真正的实现在 `keynest-paths`——因为 GUI 与 Native Host 是两个进程，
//! 两边必须算出完全相同的目录，否则会读到不同的 `bridge.key`，
//! 握手永久失败且极难定位。
//!
//! 这里保留同名函数只是为了不破坏既有调用方（`keynest_core::paths::*`）；
//! 内部一律委托给 `keynest_paths`，不再维护第二份逻辑。
//!
//! 背景（保留原注释要点）：`%APPDATA%`（Roaming）在域环境或开启「同步设置」时
//! 会被复制到漫游配置文件/其他登录会话，等于把加密库扩散到用户没预期的地方。
//! 但升级不能把用户的库"变没"，所以旧位置**已有库时**继续用旧位置，
//! 迁移必须由用户显式触发。

use std::path::PathBuf;

pub use keynest_paths::{BRIDGE_KEY_FILE, ENV_DATA_DIR, LOCK_FILE, VAULT_FILE};

/// 新安装默认位置：`%LOCALAPPDATA%\KeyNest`。
pub fn local_data_dir() -> PathBuf {
    keynest_paths::local_data_dir()
}

/// 旧版本位置：`%APPDATA%\KeyNest`。
pub fn roaming_data_dir() -> PathBuf {
    keynest_paths::roaming_data_dir()
}

/// 解析实际使用的数据目录。
///
/// 优先级：`KEYNEST_DATA_DIR` > 旧 `%APPDATA%\KeyNest`（已有库）> `%LOCALAPPDATA%\KeyNest`
pub fn resolve_data_dir() -> PathBuf {
    keynest_paths::resolve_data_dir()
}

/// 库文件完整路径。
pub fn resolve_vault_path() -> PathBuf {
    keynest_paths::resolve_vault_path()
}

/// 单实例锁文件路径。
pub fn resolve_lock_path() -> PathBuf {
    keynest_paths::resolve_lock_path()
}

/// 数据目录是否仍位于漫游目录（用于提示用户考虑迁移）。
pub fn is_on_roaming_profile() -> bool {
    keynest_paths::is_on_roaming_profile()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegates_to_shared_implementation() {
        // 转发层必须与共享实现给出完全相同的值
        assert_eq!(resolve_data_dir(), keynest_paths::resolve_data_dir());
        assert_eq!(resolve_vault_path(), keynest_paths::resolve_vault_path());
        assert_eq!(resolve_lock_path(), keynest_paths::resolve_lock_path());
    }

    #[test]
    fn vault_path_ends_with_dat() {
        let p = resolve_vault_path();
        assert_eq!(p.file_name().unwrap(), std::ffi::OsStr::new(VAULT_FILE));
    }
}
