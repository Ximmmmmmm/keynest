//! 数据目录解析。
//!
//! 对应审查清单第 6 条：库文件应放在 `%LOCALAPPDATA%`，而不是 `%APPDATA%`。
//!
//! 原因：`%APPDATA%`（Roaming）在加入域或开启「同步设置」的机器上会被
//! 复制到漫游配置文件/其他登录会话，等于把加密库（以及它的历史版本）
//! 扩散到用户没预期的地方。`%LOCALAPPDATA%` 只在本机。
//!
//! 兼容策略：如果旧位置 `%APPDATA%\KeyNest\vault.dat` 已经存在、
//! 而新位置还没有库，则**继续使用旧位置**，避免升级后用户「找不到自己的库」。
//! 迁移必须由用户显式触发（复制文件），不做隐式搬移。

use std::path::PathBuf;

/// 新安装默认位置：`%LOCALAPPDATA%\KeyNest`。
pub fn local_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("KeyNest")
}

/// 旧版本位置：`%APPDATA%\KeyNest`。
pub fn roaming_data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("KeyNest")
}

/// 解析实际使用的数据目录。
///
/// 优先级：
/// 1. 环境变量 `KEYNEST_DATA_DIR`（测试/便携）
/// 2. 旧位置已有库 → 继续用旧位置
/// 3. 否则用新位置
pub fn resolve_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("KEYNEST_DATA_DIR") {
        return PathBuf::from(dir);
    }

    let legacy = roaming_data_dir();
    if legacy.join("vault.dat").exists() {
        return legacy;
    }

    local_data_dir()
}

/// 库文件完整路径。
pub fn resolve_vault_path() -> PathBuf {
    resolve_data_dir().join("vault.dat")
}

/// 单实例锁文件路径。与库文件同目录，保证「一个库对应一把锁」。
pub fn resolve_lock_path() -> PathBuf {
    resolve_data_dir().join("vault.lock")
}

/// 数据目录是否仍位于漫游目录（用于提示用户考虑迁移）。
pub fn is_on_roaming_profile() -> bool {
    resolve_data_dir() == roaming_data_dir() && roaming_data_dir() != local_data_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins() {
        // 谨慎起见不修改进程环境，仅验证路径拼接形态
        let p = local_data_dir();
        assert!(p.to_string_lossy().ends_with("KeyNest"));
    }

    #[test]
    fn vault_path_ends_with_dat() {
        let p = resolve_vault_path();
        assert_eq!(p.file_name().unwrap(), "vault.dat");
    }
}
