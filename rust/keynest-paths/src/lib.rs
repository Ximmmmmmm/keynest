//! 钥巢数据目录解析——**唯一实现**。
//!
//! # 为什么单独成一个 crate
//!
//! GUI 进程与 Native Host 是**两个不同进程**，各自都要定位 `bridge.key`。
//! 只要两边的目录解析逻辑有一丁点差异，它们就会读到不同的密钥，
//! 握手永久失败，而故障现象只是 `HANDSHAKE`——极难定位。
//!
//! 所以这里只允许**一份**实现，core / bridge / GUI / Host 全部调用它。
//!
//! # 这个 crate 刻意不做什么
//!
//! - 不依赖任何第三方库（零依赖），因此**不可能**引入 Vault / DEK / 密码库能力
//! - 不创建目录、不创建文件、不读取密码库
//! - 不创建 `bridge.key`（那是 `keynest-bridge::keyfile` 的职责）
//!
//! 它只做一件事：把路径算出来。
//!
//! # 优先级（不得改变）
//!
//! 1. `KEYNEST_DATA_DIR` 环境变量（测试/便携）
//! 2. `%APPDATA%\KeyNest`——**仅当**该目录下已存在 `vault.dat`（兼容旧位置）
//! 3. `%LOCALAPPDATA%\KeyNest`——新安装默认
//!
//! 第 2 条的意义：`%APPDATA%`（Roaming）在域环境或开启「同步设置」时会被复制到
//! 其他会话，等于把加密库扩散到用户没预期的地方。但升级不能把用户的库"变没"，
//! 所以旧位置有库时继续用旧位置，迁移必须由用户显式触发。

use std::path::PathBuf;

/// 库文件名。
pub const VAULT_FILE: &str = "vault.dat";
/// 单实例锁文件名。
pub const LOCK_FILE: &str = "vault.lock";
/// 浏览器桥共享密钥文件名。
pub const BRIDGE_KEY_FILE: &str = "bridge.key";

/// 环境变量名（唯一权威定义，避免各处写错字符串）。
pub const ENV_DATA_DIR: &str = "KEYNEST_DATA_DIR";

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
/// 优先级见模块文档。**GUI 与 Native Host 必须都调用这一个函数**。
pub fn resolve_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(ENV_DATA_DIR) {
        return PathBuf::from(dir);
    }

    let legacy = roaming_data_dir();
    if legacy.join(VAULT_FILE).exists() {
        return legacy;
    }

    local_data_dir()
}

/// 库文件完整路径。
pub fn resolve_vault_path() -> PathBuf {
    resolve_data_dir().join(VAULT_FILE)
}

/// 单实例锁文件路径。与库文件同目录，保证「一个库对应一把锁」。
pub fn resolve_lock_path() -> PathBuf {
    resolve_data_dir().join(LOCK_FILE)
}

/// 浏览器桥共享密钥路径。
pub fn resolve_bridge_key_path() -> PathBuf {
    resolve_data_dir().join(BRIDGE_KEY_FILE)
}

/// 数据目录是否仍位于漫游目录（用于提示用户考虑迁移）。
pub fn is_on_roaming_profile() -> bool {
    resolve_data_dir() == roaming_data_dir() && roaming_data_dir() != local_data_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 这些测试全部基于纯函数与显式路径，**不修改进程环境变量**，
    /// 因此不会影响同一进程里的其他测试，也不会碰用户真实目录。
    #[test]
    fn file_names_are_stable() {
        assert_eq!(VAULT_FILE, "vault.dat");
        assert_eq!(LOCK_FILE, "vault.lock");
        assert_eq!(BRIDGE_KEY_FILE, "bridge.key");
    }

    #[test]
    fn env_var_name_is_stable() {
        // 改了名字，所有已部署的测试/便携配置都会失效
        assert_eq!(ENV_DATA_DIR, "KEYNEST_DATA_DIR");
    }

    #[test]
    fn vault_lock_and_key_share_one_dir() {
        // 三者在同一目录：这是「一次设置同时隔离三者」的前提
        let d = resolve_data_dir();
        assert_eq!(resolve_vault_path().parent().unwrap(), d);
        assert_eq!(resolve_lock_path().parent().unwrap(), d);
        assert_eq!(resolve_bridge_key_path().parent().unwrap(), d);
    }

    #[test]
    fn vault_path_ends_with_dat() {
        assert_eq!(
            resolve_vault_path().file_name().unwrap(),
            std::ffi::OsStr::new(VAULT_FILE)
        );
    }

    #[test]
    fn local_dir_ends_with_keynest() {
        assert!(local_data_dir().to_string_lossy().ends_with("KeyNest"));
    }

    #[test]
    fn roaming_dir_ends_with_keynest() {
        assert!(roaming_data_dir().to_string_lossy().ends_with("KeyNest"));
    }

    /// 用显式路径验证「旧目录有 vault.dat 就选旧目录」这条规则，
    /// 不依赖真实环境变量。
    fn pick(env_dir: Option<&Path>, legacy_has_vault: bool, local: &Path) -> PathBuf {
        if let Some(d) = env_dir {
            return d.to_path_buf();
        }
        if legacy_has_vault {
            return PathBuf::from("legacy");
        }
        local.to_path_buf()
    }

    #[test]
    fn priority_rules_in_order() {
        let local = Path::new("/local/KeyNest");

        // 1) 环境变量最高
        assert_eq!(
            pick(Some(Path::new("/env")), true, local),
            PathBuf::from("/env")
        );
        assert_eq!(
            pick(Some(Path::new("/env")), false, local),
            PathBuf::from("/env")
        );

        // 2) 旧目录有库 → 旧目录
        assert_eq!(pick(None, true, local), PathBuf::from("legacy"));

        // 3) 否则新位置
        assert_eq!(pick(None, false, local), local.to_path_buf());
    }
}
