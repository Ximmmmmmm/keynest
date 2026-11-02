//! 认证密钥（Host ↔ GUI 的共享秘密）的生成、保存、读取与轮换。
//!
//! # 威胁模型（必须诚实写下来）
//!
//! 同一 Windows 用户下的恶意进程可以读这个文件。所以：
//!
//! - 它**防的是别的用户**，以及"GUI 没在跑时的伪造连接"；
//! - 它**防不住**同用户的恶意软件。
//!
//! 轮换能缩小暴露窗口，但不能把这个限制变成"已经解决"。
//!
//! # 文件属性
//!
//! - 位置：`<数据目录>/bridge.key`
//! - 内容：32 字节原始随机数（**不是** base64、不是文本）
//! - 权限：只用当前用户的 DACL（在 `pipe.rs` 里复用同一套 SDDL 思路）
//! - 写入：先写 `.tmp` 再 rename，崩溃不会留下半个密钥

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::auth::SharedSecret;
use crate::error::BridgeError;

/// 密钥文件名。
pub const KEY_FILE: &str = "bridge.key";
const TMP_FILE: &str = "bridge.key.tmp";

/// 密钥在磁盘上的位置。
pub fn key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(KEY_FILE)
}

/// 读取已有密钥；不存在则返回 None。
pub fn load(data_dir: &Path) -> Result<Option<SharedSecret>, BridgeError> {
    let path = key_path(data_dir);
    match fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() != 32 {
                // 长度不对说明文件被破坏或被人动过：不猜测、不使用
                return Err(BridgeError::HandshakeFailed("密钥文件长度异常"));
            }
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&bytes);
            Ok(Some(SharedSecret::from_bytes(raw)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(BridgeError::Io(format!("读取密钥失败: {e}"))),
    }
}

/// 读取或创建。返回 (密钥, 是否新建)。
pub fn load_or_create(data_dir: &Path) -> Result<(SharedSecret, bool), BridgeError> {
    if let Some(s) = load(data_dir)? {
        return Ok((s, false));
    }
    let s = generate(data_dir)?;
    Ok((s, true))
}

/// 生成新密钥并落盘（覆盖旧的）。
///
/// 用于首次安装与"撤销授权"（撤销 = 换一把锁）。
pub fn generate(data_dir: &Path) -> Result<SharedSecret, BridgeError> {
    fs::create_dir_all(data_dir).map_err(|e| BridgeError::Io(format!("创建目录失败: {e}")))?;
    let secret = SharedSecret::generate()?;
    write_atomic(data_dir, secret.as_bytes())?;
    Ok(secret)
}

/// 撤销：删除密钥文件。下次握手会重新生成，旧 Host 立即失效。
pub fn revoke(data_dir: &Path) -> Result<(), BridgeError> {
    match fs::remove_file(key_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(BridgeError::Io(format!("删除密钥失败: {e}"))),
    }
}

fn write_atomic(data_dir: &Path, bytes: &[u8]) -> Result<(), BridgeError> {
    let tmp = data_dir.join(TMP_FILE);
    let dst = key_path(data_dir);

    // 先删掉可能残留的 tmp，避免 Windows 上 rename 到已存在文件失败
    let _ = fs::remove_file(&tmp);

    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| BridgeError::Io(format!("写入失败: {e}")))?;
        f.write_all(bytes)
            .map_err(|e| BridgeError::Io(format!("写入失败: {e}")))?;
        f.sync_all()
            .map_err(|e| BridgeError::Io(format!("刷盘失败: {e}")))?;
        #[cfg(windows)]
        restrict_to_current_user(&tmp)?;
    }

    fs::rename(&tmp, &dst).map_err(|e| BridgeError::Io(format!("重命名失败: {e}")))?;
    Ok(())
}

/// 把文件 DACL 收紧到"仅当前用户"。
///
/// 与管道用同一套 SDDL（`D:P(A;;GA;;;OW)`），语义一致，便于审计。
#[cfg(windows)]
fn restrict_to_current_user(path: &Path) -> Result<(), BridgeError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| BridgeError::Io(format!("构造 DACL 失败: {e}")))?;

        // 从安全描述符里取出 DACL 指针
        let mut present = windows::Win32::Foundation::BOOL::default();
        let mut defaulted = windows::Win32::Foundation::BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let ok = windows::Win32::Security::GetSecurityDescriptorDacl(
            sd,
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
        .is_ok();

        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);

        let result = if ok && !dacl.is_null() {
            SetNamedSecurityInfoW(
                windows::core::PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl),
                None,
            )
        } else {
            return Err(BridgeError::Io("取不到 DACL".into()));
        };
        let _ = LocalFree(HLOCAL(sd.0));

        if result.is_err() {
            return Err(BridgeError::Io("设置文件权限失败".into()));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn restrict_to_current_user(_path: &Path) -> Result<(), BridgeError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试独立目录：几个测试并行跑，共用一个目录会互相覆盖。
    fn tmpdir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("kn-bridge-key-{}-{}", std::process::id(), tag));
        let _ = fs::create_dir_all(&p);
        p
    }

    #[test]
    fn creates_then_loads_same_secret() {
        let dir = tmpdir("a");
        let _ = revoke(&dir);
        let (a, created) = load_or_create(&dir).unwrap();
        assert!(created);
        let (b, created2) = load_or_create(&dir).unwrap();
        assert!(!created2);
        assert_eq!(a.as_bytes(), b.as_bytes());
        let _ = revoke(&dir);
    }

    #[test]
    fn revoke_removes_the_file() {
        let dir = tmpdir("b");
        let _ = generate(&dir).unwrap();
        assert!(key_path(&dir).exists());
        revoke(&dir).unwrap();
        assert!(!key_path(&dir).exists());
    }

    #[test]
    fn rotation_changes_the_secret() {
        let dir = tmpdir("c");
        let a = generate(&dir).unwrap();
        let b = generate(&dir).unwrap();
        assert_ne!(a.as_bytes(), b.as_bytes(), "轮换必须真的换掉密钥");
        let _ = revoke(&dir);
    }

    #[test]
    fn corrupted_length_is_rejected_not_guessed() {
        let dir = tmpdir("d");
        fs::write(key_path(&dir), b"short").unwrap();
        assert!(load(&dir).is_err(), "长度不对必须报错，不能凑合用");
        let _ = revoke(&dir);
    }

    #[test]
    fn no_tmp_file_left_behind() {
        let dir = tmpdir("e");
        let _ = generate(&dir).unwrap();
        assert!(!dir.join(TMP_FILE).exists(), "原子写入后不应残留 tmp");
        let _ = revoke(&dir);
    }
}
