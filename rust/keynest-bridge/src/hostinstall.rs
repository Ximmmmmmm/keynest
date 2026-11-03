//! 安装 / 卸载浏览器桥接的 Native Messaging 宿主。
//!
//! # 为什么需要这个模块
//!
//! 扩展与桌面程序之间的全部通信，都要经过浏览器启动的
//! `keynest-native-host.exe` 这个进程。浏览器只在**注册表**里找它：
//!
//! ```text
//! HKCU\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge
//! HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge
//! ```
//!
//! 值是清单 JSON 的绝对路径，JSON 里写着宿主的 exe 路径与允许的扩展 ID。
//!
//! 没有这一步，扩展装上了也**连不上**——握手根本起不了步。
//!
//! # 关键约束
//!
//! 1. **只写 HKCU**：不需要管理员权限，与"绿色版"定位一致。
//! 2. **只删自己写的东西**：卸载时绝不碰 `vault.dat`、
//!    也绝不碰别的软件的 `NativeMessagingHosts` 项。
//! 3. **允许的扩展 ID 必须由调用方给出**，绝不在代码里硬编码一个
//!    "看起来对"的 ID。未登记的 ID 连不上——这是正确行为，不是 bug。
//!    未发布到商店的扩展 ID 由**路径哈希**决定，每台机器不同，
//!    所以只能由用户（或扩展自己）告知。
//!
//! # 回滚
//!
//! 安装分几步，任何一步失败都要把**已经做的**撤销。
//! 顺序刻意是「先文件、后注册表」：注册表项比文件难清理得多，
//! 放在后面意味着失败时残留的可能性更小。

use std::path::{Path, PathBuf};

use crate::error::BridgeError;

/// Native Messaging 主机名。必须与扩展的约定一致。
pub const HOST_NAME: &str = "com.keynest.bridge";

/// 清单文件名（放在数据目录里）。
pub const HOST_MANIFEST_FILE: &str = "com.keynest.bridge.json";

/// 宿主 exe 的文件名。
pub const HOST_EXE_NAME: &str = "keynest-native-host.exe";

/// 宿主在数据目录里的子目录名。
pub const HOST_BIN_DIR: &str = "bin";

/// 安装结果：告诉调用方实际发生了什么。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct InstallReport {
    /// 宿主的最终路径。
    pub host_exe: PathBuf,
    /// 清单 JSON 的路径。
    pub manifest: PathBuf,
    /// 实际写入注册表的浏览器列表。
    pub registered_browsers: Vec<String>,
    /// 已有但未改动的项（已经是正确的值）。
    pub already_correct: Vec<String>,
}

impl InstallReport {
    /// 一句话总结，给界面用。
    pub fn summary(&self) -> String {
        if self.registered_browsers.is_empty() {
            "浏览器桥接已经就绪".to_string()
        } else {
            format!(
                "已为 {} 安装浏览器桥接",
                self.registered_browsers.join("、")
            )
        }
    }
}

/// 宿主的最终路径（数据目录下的 bin 子目录）。
pub fn host_exe_path(data_dir: &Path) -> PathBuf {
    data_dir.join(HOST_BIN_DIR).join(HOST_EXE_NAME)
}

/// 清单 JSON 的路径。
pub fn manifest_path(data_dir: &Path) -> PathBuf {
    data_dir.join(HOST_MANIFEST_FILE)
}

/// 生成清单 JSON 的内容。
///
/// # 为什么用 `serde_json` 而不是手拼字符串
///
/// JSON 里的路径要转义反斜杠（`C:\Users\...` → `C:\\Users\\...`）。
/// 手拼很容易漏掉，而漏掉的表现是浏览器**静默拒绝**这个宿主——
/// 用户看到的是「扩展连不上」，日志里什么都没有。
pub fn build_manifest(host_exe: &Path, extension_ids: &[String]) -> Result<String, BridgeError> {
    if extension_ids.is_empty() {
        return Err(BridgeError::InvalidValue(
            "至少需要一个扩展 ID：未登记的 ID 连不上，这是浏览器的正确行为".into(),
        ));
    }
    // 扩展 ID 必须是 32 个小写字母（a–p），这是 Chromium 的规则。
    // 写错的话浏览器会拒绝这个清单，而错误信息只有一句
    // 「Invalid value for 'allowed_origins'」，用户完全无从下手。
    for id in extension_ids {
        if !is_valid_extension_id(id) {
            return Err(BridgeError::InvalidValue(format!(
                "扩展 ID 不合法：{id}（应当是 32 个 a–p 的小写字母）"
            )));
        }
    }

    let origins: Vec<String> = extension_ids
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect();

    let manifest = serde_json::json!({
        "name": HOST_NAME,
        "description": "KeyNest Browser Bridge",
        "path": host_exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });

    serde_json::to_string_pretty(&manifest)
        .map_err(|e| BridgeError::Io(format!("序列化清单失败: {e}")))
}

/// Chromium 的扩展 ID 规则：恰好 32 个字符，每个都是 `a`–`p`。
pub fn is_valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// 查桥接当前是否已安装（**只读**，不写任何东西）。
///
/// # 为什么需要只读的版本
///
/// 设置页每次打开都要显示「已安装 / 尚未安装」。
/// 如果复用 `install()` 来查，就会**每次打开设置都重写一遍注册表**——
/// 那既没必要，也会让用户在不知情的情况下被修改系统状态。
pub fn is_installed(data_dir: &Path) -> bool {
    // 宿主 exe 在，且清单在——两者齐了才算装好。
    if !host_exe_path(data_dir).exists() {
        return false;
    }
    if !manifest_path(data_dir).exists() {
        return false;
    }
    // 清单里写的路径要与我们算的一致——用户换了目录重装的话，
    // 清单会指向旧路径，那份是失效的。
    let Ok(text) = std::fs::read_to_string(manifest_path(data_dir)) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let want = host_exe_path(data_dir).to_string_lossy().to_string();
    v.get("path")
        .and_then(|p| p.as_str())
        .map(|p| p == want)
        .unwrap_or(false)
}

/// 安装浏览器桥接宿主。
///
/// # 参数
///
/// * `data_dir` —— 数据目录（与 `bridge.key` 同目录）
/// * `host_exe_src` —— 宿主 exe 的来源（通常是与 GUI 同目录的那个）
/// * `extension_ids` —— 允许连接的扩展 ID
///
/// # 失败时的行为
///
/// 已经做的步骤会被撤销（尽力而为）。注册表项最后写，
/// 所以残留的可能性最小。
pub fn install(
    data_dir: &Path,
    host_exe_src: &Path,
    extension_ids: &[String],
) -> Result<InstallReport, BridgeError> {
    install_with_registry(data_dir, host_exe_src, extension_ids, true)
}

/// 与 [`install`] 相同，但可以指定「只读不写注册表」或用自定义的注册表路径。
///
/// # 为什么要有这个变体
///
/// 端到端测试必须能验证「装完之后注册表里真的有东西、卸完之后真的没了」。
/// 而测试**不能**碰真实的 `NativeMessagingHosts` —— 那是别的软件也在用的
/// 地方，测试留下痕迹就是在用户机器上留垃圾。
///
/// 所以把「写哪些键」变成参数：生产用真实的那个，测试用
/// `Software\KeyNest\Test\...` 下面的专用键。
///
/// `write_registry = false` 时完全跳过注册表，只做文件部分。
pub fn install_with_registry(
    data_dir: &Path,
    host_exe_src: &Path,
    extension_ids: &[String],
    write_registry: bool,
) -> Result<InstallReport, BridgeError> {
    install_at(data_dir, host_exe_src, extension_ids, write_registry, None)
}

/// 真正干活的实现。`registry_paths` 为 `None` 时用生产路径。
fn install_at(
    data_dir: &Path,
    host_exe_src: &Path,
    extension_ids: &[String],
    write_registry: bool,
    registry_paths: Option<&[(&str, &str)]>,
) -> Result<InstallReport, BridgeError> {
    let manifest_json = build_manifest(&host_exe_path(data_dir), extension_ids)?;

    if !host_exe_src.exists() {
        return Err(BridgeError::Io(format!(
            "找不到宿主程序：{}（发布包里应该有 keynest-native-host.exe）",
            host_exe_src.display()
        )));
    }

    let bin_dir = data_dir.join(HOST_BIN_DIR);
    std::fs::create_dir_all(&bin_dir).map_err(|e| BridgeError::Io(format!("创建目录失败: {e}")))?;

    // 1) 复制宿主
    let dst_exe = host_exe_path(data_dir);
    let copied = copy_file(host_exe_src, &dst_exe);
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&dst_exe);
        return Err(e);
    }

    // 2) 写清单
    let manifest = manifest_path(data_dir);
    if let Err(e) = std::fs::write(&manifest, manifest_json.as_bytes()) {
        let _ = std::fs::remove_file(&dst_exe);
        return Err(BridgeError::Io(format!("写清单失败: {e}")));
    }
    let manifest_path_for_reg = manifest.clone();

    // 3) 写注册表
    let mut report = InstallReport {
        host_exe: dst_exe.clone(),
        manifest: manifest.clone(),
        ..Default::default()
    };
    let manifest_str = manifest_path_for_reg.to_string_lossy().to_string();

    let targets: Vec<(&str, &str)> = match registry_paths {
        Some(p) => p.to_vec(),
        None => BROWSERS.iter().map(|b| (b.name, b.key_path)).collect(),
    };

    for (name, key_path) in &targets {
        if !write_registry {
            continue;
        }
        match write_registry_value_at(key_path, &manifest_str) {
            Ok(WriteOutcome::Written) => report.registered_browsers.push((*name).to_string()),
            Ok(WriteOutcome::AlreadyCorrect) => report.already_correct.push((*name).to_string()),
            Err(e) => {
                // 回滚：把已经写的注册表项撤掉，再删文件
                for b in &report.registered_browsers {
                    if let Some((_, path)) = targets.iter().find(|(n, _)| *n == b.as_str()) {
                        let _ = delete_registry_value_at(path);
                    }
                }
                let _ = std::fs::remove_file(&manifest_path_for_reg);
                let _ = std::fs::remove_file(&dst_exe);
                return Err(e);
            }
        }
    }

    Ok(report)
}

/// 卸载：只删自己写的东西。
///
/// **绝不**碰 `vault.dat` 及其备份，**绝不**碰别的软件的
/// `NativeMessagingHosts` 项——只删 `com.keynest.bridge` 这一个值。
pub fn uninstall(data_dir: &Path) -> Result<InstallReport, BridgeError> {
    uninstall_at(data_dir, None)
}

/// 与 [`uninstall`] 相同，但可以用自定义的注册表路径（给测试用）。
pub fn uninstall_at(
    data_dir: &Path,
    registry_paths: Option<&[(&str, &str)]>,
) -> Result<InstallReport, BridgeError> {
    let mut report = InstallReport {
        host_exe: host_exe_path(data_dir),
        manifest: manifest_path(data_dir),
        ..Default::default()
    };

    let targets: Vec<(&str, &str)> = match registry_paths {
        Some(p) => p.to_vec(),
        None => BROWSERS.iter().map(|b| (b.name, b.key_path)).collect(),
    };
    for (name, key_path) in &targets {
        if delete_registry_value_at(key_path) {
            report.registered_browsers.push((*name).to_string());
        }
    }

    let _ = std::fs::remove_file(&report.manifest);
    let _ = std::fs::remove_file(host_exe_path(data_dir));
    // bin 目录只在空了的情况下删——用户可能往里放了别的东西
    let bin = data_dir.join(HOST_BIN_DIR);
    if let Ok(mut it) = std::fs::read_dir(&bin) {
        if it.next().is_none() {
            let _ = std::fs::remove_dir(&bin);
        }
    }
    Ok(report)
}

/// 支持的浏览器。
struct Browser {
    /// 显示名。
    name: &'static str,
    /// 注册表路径（相对 HKCU）。
    key_path: &'static str,
}

/// 浏览器列表。
///
/// 只认 Chrome 与 Edge——它们的 Native Messaging 路径一样。
/// Firefox 用的是完全不同的机制（扩展自己的清单文件），
/// 本项目没做 Firefox 的安装，所以这里也不假装支持。
const BROWSERS: &[Browser] = &[
    Browser {
        name: "Chrome",
        key_path: r"Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge",
    },
    Browser {
        name: "Edge",
        key_path: r"Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge",
    },
];

/// 写注册表项的结果。
#[derive(Debug, PartialEq)]
pub enum WriteOutcome {
    /// 写入成功（之前没有或值不同）。
    Written,
    /// 已经是正确的值，无需改动。
    AlreadyCorrect,
}

/// 复制文件（覆盖）。
fn copy_file(src: &Path, dst: &Path) -> Result<(), BridgeError> {
    std::fs::copy(src, dst).map_err(|e| BridgeError::Io(format!("复制宿主失败: {e}")))?;
    Ok(())
}

#[cfg(windows)]
mod reg {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    /// 打开（或创建）HKCU 下的键。
    fn open_key(
        path: &str,
        access: windows::Win32::System::Registry::REG_SAM_FLAGS,
    ) -> Option<HKEY> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut hkey = HKEY::default();
        // SAFETY: wide 是以 NUL 结尾的；写入的 hkey 在成功时被返回，
        // 失败时 hkey 不会被使用。
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(wide.as_ptr()),
                0,
                PCWSTR(std::ptr::null()),
                REG_OPTION_NON_VOLATILE,
                access,
                None,
                &mut hkey,
                None,
            )
        };
        if status == ERROR_SUCCESS {
            Some(hkey)
        } else {
            None
        }
    }

    /// 读一个字符串值。
    pub fn read_value(path: &str) -> Option<String> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut size = 0u32;
        // SAFETY: 先用 null 缓冲区问长度，这是 Win32 的标准做法。
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(wide.as_ptr()),
                PCWSTR(std::ptr::null()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize) / 2 + 1];
        // SAFETY: buf 足够大，size 是上面问出来的字节数。
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(wide.as_ptr()),
                PCWSTR(std::ptr::null()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        buf.truncate(end);
        Some(String::from_utf16_lossy(&buf))
    }

    /// 写一个字符串值（默认名称）。
    pub fn write_value(path: &str, value: &str) -> bool {
        let hkey = match open_key(path, KEY_WRITE) {
            Some(k) => k,
            None => return false,
        };
        let wide_val: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = unsafe {
            std::slice::from_raw_parts(wide_val.as_ptr() as *const u8, wide_val.len() * 2)
        };
        // SAFETY: hkey 来自 open_key；bytes 以 NUL 结尾且长度正确。
        let status =
            unsafe { RegSetValueExW(hkey, PCWSTR(std::ptr::null()), 0, REG_SZ, Some(bytes)) };
        // SAFETY: 关闭我们打开的键。
        unsafe {
            let _ =
                windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(hkey.0));
        }
        status == ERROR_SUCCESS
    }

    /// 删一个值（键本身留着——Chrome/Edge 的键可能还有别的值）。
    /// 删掉整个键（含它的所有值）。
    ///
    /// `RegDeleteValueW` 只删**值**，键本身还在。测试要的是"不留痕迹"，
    /// 所以额外提供删键的能力。
    ///
    /// 只在测试里用——生产路径不需要删键（卸载只删自己的**值**，
    /// 键留着是为了不破坏 Chrome/Edge 自己的目录结构）。
    #[cfg(test)]
    pub fn delete_key(path: &str) -> bool {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: wide 以 NUL 结尾；删的是 HKCU 下的子键。
        let status = unsafe {
            windows::Win32::System::Registry::RegDeleteKeyW(
                HKEY_CURRENT_USER,
                PCWSTR(wide.as_ptr()),
            )
        };
        status == ERROR_SUCCESS
    }

    pub fn delete_value(path: &str) -> bool {
        // 必须**先打开键**再删它的默认值。
        //
        // 之前写的是 `RegDeleteValueW(HKEY_CURRENT_USER, null)`——
        // 那是去删 HKCU **根键**的默认值（根本不存在），
        // 我们自己那个键的值会一直留着，卸载等于没卸。
        let hkey = match open_key(path, KEY_WRITE) {
            Some(k) => k,
            None => return false,
        };
        // SAFETY: hkey 是刚打开的；删的是它的**默认**值（名称为 NULL）。
        let status = unsafe { RegDeleteValueW(hkey, PCWSTR(std::ptr::null())) };
        // SAFETY: 关闭我们打开的键。
        unsafe {
            let _ =
                windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(hkey.0));
        }
        status == ERROR_SUCCESS
    }
}

/// 只删**指定的**那个键的默认值。
///
/// 内部版本，路径可注入——测试用它指向一个测试专用键，
/// 绝不碰真实的 `NativeMessagingHosts`。
#[cfg(windows)]
fn delete_registry_value_at(path: &str) -> bool {
    reg::delete_value(path)
}

/// 写**指定的**那个键的默认值。
#[cfg(windows)]
fn write_registry_value_at(path: &str, value: &str) -> Result<WriteOutcome, BridgeError> {
    if let Some(cur) = reg::read_value(path) {
        if cur == value {
            return Ok(WriteOutcome::AlreadyCorrect);
        }
    }
    if reg::write_value(path, value) {
        Ok(WriteOutcome::Written)
    } else {
        Err(BridgeError::Io(format!("写入注册表失败：{path}")))
    }
}

#[cfg(not(windows))]
fn write_registry_value(_browser: &str, _value: &str) -> Result<WriteOutcome, BridgeError> {
    // 非 Windows 上没有注册表这回事。直接报「不支持」而不是假装成功。
    Err(BridgeError::Io(
        "当前平台没有 Windows 注册表，无法安装浏览器桥接".into(),
    ))
}

#[cfg(not(windows))]
fn delete_registry_value(_browser: &str) -> Result<bool, BridgeError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_contains_the_exe_path_and_origins() {
        let exe = PathBuf::from(r"C:\Users\test\AppData\Local\KeyNest\bin\keynest-native-host.exe");
        let id = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let json = build_manifest(&exe, std::slice::from_ref(&id)).unwrap();

        assert!(json.contains("com.keynest.bridge"));
        assert!(json.contains("stdio"));
        assert!(json.contains("chrome-extension://"));
        assert!(json.contains(&id));
        // 路径里的反斜杠必须被转义，否则 JSON 解析失败
        assert!(json.contains(r"C:\\Users\\test"));
        // 反过来：不能出现未转义的反斜杠
        assert!(!json.contains(r"C:\Users"));
    }

    #[test]
    fn manifest_is_valid_json() {
        let exe = PathBuf::from("/tmp/host.exe");
        let id = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let json = build_manifest(&exe, &[id]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).expect("必须是合法 JSON");
        assert_eq!(v["name"], "com.keynest.bridge");
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["allowed_origins"].as_array().unwrap().len(), 1);
    }

    /// 没有扩展 ID 时必须拒绝。
    ///
    /// 写一个空的 `allowed_origins` 的清单，浏览器会加载它但**永远连不上**——
    /// 用户看到的现象是「扩展一直显示未连接」，没有任何错误提示。
    /// 与其那样，不如明确拒绝并说清原因。
    #[test]
    fn empty_extension_id_list_is_rejected() {
        let exe = PathBuf::from("/tmp/host.exe");
        let err = build_manifest(&exe, &[]).unwrap_err();
        assert!(err.to_string().contains("扩展 ID"));
    }

    /// 扩展 ID 必须是 32 个 a–p 的小写字母。
    ///
    /// Chromium 的硬性规则。写错的话浏览器拒绝整个清单，
    /// 错误信息只有一句「Invalid value for 'allowed_origins'」——
    /// 用户完全无从下手。
    #[test]
    fn invalid_extension_ids_are_rejected_with_a_clear_message() {
        let exe = PathBuf::from("/tmp/host.exe");
        for bad in [
            "short",
            "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP",  // 大写
            "abcdefghijklmnopabcdefghijklmnopq", // 33 个
            "abcdefghijklmnopabcdefghijklmno!",  // 非法字符
            "qrstuvwxyzabcdefghijklmnopabcdef",  // 超出 a–p
        ] {
            let err = build_manifest(&exe, &[bad.to_string()]).unwrap_err();
            assert!(
                err.to_string().contains("不合法"),
                "错误信息应当说清是 ID 不合法：{err}"
            );
        }
    }

    #[test]
    fn valid_extension_id_is_accepted() {
        let id = "abcdefghijklmnopabcdefghijklmnop";
        assert!(is_valid_extension_id(id));
        assert!(!is_valid_extension_id(""));
        assert!(!is_valid_extension_id(&id[..31]));
        assert!(!is_valid_extension_id(&id.to_uppercase()));
    }

    /// 多个扩展 ID 要全部写进 `allowed_origins`。
    ///
    /// 开发 ID 与商店 ID 不同，两边都要能连上。
    #[test]
    fn multiple_extension_ids_are_all_listed() {
        let exe = PathBuf::from("/tmp/host.exe");
        let a = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let b = "ponmlkjihgfedcbaponmlkjihgfedcba".to_string();
        let json = build_manifest(&exe, &[a.clone(), b.clone()]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let origins = v["allowed_origins"].as_array().unwrap();
        assert_eq!(origins.len(), 2);
        assert!(origins[0].as_str().unwrap().contains(&a));
        assert!(origins[1].as_str().unwrap().contains(&b));
    }

    #[test]
    fn paths_live_under_the_data_dir() {
        let d = PathBuf::from("/data");
        assert_eq!(
            host_exe_path(&d),
            d.join("bin").join("keynest-native-host.exe")
        );
        assert_eq!(manifest_path(&d), d.join("com.keynest.bridge.json"));
    }

    /// 注册表往返：写 → 读 → 删。
    ///
    /// 用**测试专用**的子键（`Software\KeyNest\Test\...`），
    /// 绝不碰真实的 `NativeMessagingHosts`——那里是别的软件也在用的地方。
    ///
    /// 这一条守住的是「卸载真的删掉了注册表项」。
    /// 之前 `RegDeleteValueW` 的参数写错了（删的是 HKCU 根键的默认值，
    /// 不是我们那个键的），卸载等于没卸——而单元测试完全测不出来，
    /// 因为那一步根本没被执行。
    #[cfg(windows)]
    #[test]
    fn registry_value_round_trips_under_a_test_key() {
        let path = r"Software\KeyNest\Test\HostInstallRoundTrip";
        let value = r"C:	est\data\com.keynest.bridge.json";

        // 写
        let outcome = write_registry_value_at(path, value).unwrap();
        assert_eq!(outcome, WriteOutcome::Written);

        // 读回来
        assert_eq!(reg::read_value(path).as_deref(), Some(value));

        // 再写一次同样的值 → 不算改动
        let again = write_registry_value_at(path, value).unwrap();
        assert_eq!(again, WriteOutcome::AlreadyCorrect);

        // 删
        assert!(delete_registry_value_at(path));
        assert_eq!(reg::read_value(path), None, "删除后应当读不到");

        // 清理测试键本身（RegDeleteValueW 只删值，键还在）
        let _ = reg::delete_key(path);
        assert_eq!(reg::read_value(path), None, "测试不应在注册表里留下痕迹");
    }

    /// 未安装时 `is_installed` 必须是 false——**只读**，不写任何东西。
    ///
    /// 这条守住「打开设置不会改动系统状态」。
    /// 如果这里偷偷调用了 `install()`，用户每次打开设置页
    /// 都会被写一遍注册表——而他什么也没要求。
    #[test]
    fn is_installed_is_false_before_installing() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        assert!(!is_installed(data_dir));

        // 放一个假的宿主 exe，但还没有清单 —— 仍然算没装
        std::fs::create_dir_all(data_dir.join(HOST_BIN_DIR)).unwrap();
        std::fs::write(host_exe_path(data_dir), b"fake").unwrap();
        assert!(!is_installed(data_dir), "缺清单时不算已安装");
    }

    /// 清单里的路径与实际路径不一致时不算已安装。
    ///
    /// 用户换了目录重装，清单还指着旧路径——那份是失效的，
    /// 显示「已安装」会让用户以为装好了，其实连不上。
    #[test]
    fn is_installed_requires_the_manifest_to_point_at_the_current_path() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        std::fs::create_dir_all(data_dir.join(HOST_BIN_DIR)).unwrap();
        std::fs::write(host_exe_path(data_dir), b"fake").unwrap();

        // 清单指向别处
        let manifest = manifest_path(data_dir);
        std::fs::write(
            &manifest,
            br#"{"name":"com.keynest.bridge","path":"C:\\old\\host.exe","type":"stdio","allowed_origins":[]}"#,
        )
        .unwrap();
        assert!(!is_installed(data_dir), "路径不符时不该算已安装");

        // 改成当前路径
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        v["path"] =
            serde_json::Value::String(host_exe_path(data_dir).to_string_lossy().to_string());
        std::fs::write(&manifest, serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(is_installed(data_dir), "路径一致时才算已安装");
    }

    /// 端到端：安装 → 验证 → 卸载 → 验证清干净。
    ///
    /// # 为什么要有这条
    ///
    /// 安装分散在好几步：复制 exe、写清单、写两条注册表项。
    /// 任何一步漏了，用户看到的都是「扩展连不上」，
    /// 而程序这边没有任何异常。
    ///
    /// 这条测试把整条链路跑一遍并**逐项验证**——
    /// 单元测试各自只覆盖一个函数，看不出它们拼起来对不对。
    ///
    /// 注册表用**测试专用**路径（`Software\KeyNest\Test\...`），
    /// 绝不碰真实的 `NativeMessagingHosts`。
    #[cfg(windows)]
    #[test]
    fn end_to_end_install_then_uninstall_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");

        // 准备一个假的宿主 exe
        let src_exe = dir.path().join("keynest-native-host.exe");
        std::fs::write(&src_exe, b"fake host binary").unwrap();

        let id = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let test_keys: Vec<(&str, &str)> = vec![
            ("TestChrome", r"Software\KeyNest\Test\ChromeHost"),
            ("TestEdge", r"Software\KeyNest\Test\EdgeHost"),
        ];

        // ---- 安装 ----
        let report = install_at(
            &data_dir,
            &src_exe,
            std::slice::from_ref(&id),
            true,
            Some(&test_keys),
        )
        .unwrap();
        assert_eq!(report.registered_browsers.len(), 2, "两条注册表项都要写");
        assert_eq!(report.already_correct.len(), 0);

        // 宿主 exe 已复制
        assert!(host_exe_path(&data_dir).exists(), "宿主 exe 没复制过去");
        assert_eq!(
            std::fs::read(host_exe_path(&data_dir)).unwrap(),
            b"fake host binary"
        );

        // 清单已写，且内容正确
        let manifest = manifest_path(&data_dir);
        assert!(manifest.exists(), "清单没写");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
        assert_eq!(v["name"], "com.keynest.bridge");
        assert_eq!(v["type"], "stdio");
        assert!(v["path"]
            .as_str()
            .unwrap()
            .ends_with("keynest-native-host.exe"));
        assert!(v["allowed_origins"][0].as_str().unwrap().contains(&id));

        // 两条注册表项都真的写进去了，且值指向清单
        for (_, key) in &test_keys {
            assert_eq!(
                reg::read_value(key).as_deref(),
                Some(manifest.to_string_lossy().as_ref()),
                "注册表 {key} 的值不对"
            );
        }

        // 此时应当判定为「已安装」
        assert!(is_installed(&data_dir), "装完应当算已安装");

        // ---- 卸载 ----
        let report = uninstall_at(&data_dir, Some(&test_keys)).unwrap();
        assert_eq!(report.registered_browsers.len(), 2, "两条注册表项都要删");

        // 注册表干净
        for (_, key) in &test_keys {
            assert_eq!(reg::read_value(key), None, "注册表 {key} 没删干净");
        }
        // 清理测试键本身（RegDeleteValueW 只删值，键还在）
        for (_, key) in &test_keys {
            let _ = reg::delete_key(key);
        }
        // 连父键一起删：测试不该在用户机器上留任何痕迹
        let _ = reg::delete_key(r"Software\KeyNest\Test");

        // 文件干净
        assert!(!manifest.exists(), "清单没删");
        assert!(!host_exe_path(&data_dir).exists(), "宿主 exe 没删");
        assert!(!is_installed(&data_dir), "卸完不该算已安装");
    }

    /// 重复安装**幂等**：不会多出东西，也不会报错。
    ///
    /// 用户在设置页点了两次「安装」很常见。
    #[cfg(windows)]
    #[test]
    fn installing_twice_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let src_exe = dir.path().join("keynest-native-host.exe");
        std::fs::write(&src_exe, b"fake").unwrap();
        let id = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let keys: Vec<(&str, &str)> = vec![("T", r"Software\KeyNest\Test\Idempotent")];

        install_at(
            &data_dir,
            &src_exe,
            std::slice::from_ref(&id),
            true,
            Some(&keys),
        )
        .unwrap();
        let second = install_at(
            &data_dir,
            &src_exe,
            std::slice::from_ref(&id),
            true,
            Some(&keys),
        )
        .unwrap();

        assert!(second.registered_browsers.is_empty(), "第二次不该再写");
        assert_eq!(
            second.already_correct.len(),
            1,
            "第二次应当识别为「已经是对的」"
        );

        let _ = reg::delete_key(keys[0].1);
        let _ = reg::delete_key(r"Software\KeyNest\Test");
    }

    /// 缺宿主 exe 时**不写注册表**。
    ///
    /// 顺序很重要：文件都拿不到，注册表就不该被改动。
    /// 否则用户会看到一个「已安装」但其实没有宿主的坏状态。
    #[cfg(windows)]
    #[test]
    fn missing_host_exe_leaves_the_registry_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let id = "abcdefghijklmnopabcdefghijklmnop".to_string();
        let keys: Vec<(&str, &str)> = vec![("T", r"Software\KeyNest\Test\NoExe")];

        let err = install_at(
            &data_dir,
            &dir.path().join("不存在.exe"),
            std::slice::from_ref(&id),
            true,
            Some(&keys),
        )
        .unwrap_err();
        assert!(err.to_string().contains("keynest-native-host.exe"));

        assert_eq!(reg::read_value(keys[0].1), None, "注册表不该被写");
    }

    /// 缺宿主 exe 时要给出**能照着做**的错误。
    #[test]
    fn missing_host_exe_gives_an_actionable_message() {
        let dir = tempfile::tempdir().unwrap();
        let err = install(
            dir.path(),
            &dir.path().join("不存在.exe"),
            &["abcdefghijklmnopabcdefghijklmnop".to_string()],
        )
        .unwrap_err();
        assert!(err.to_string().contains("keynest-native-host.exe"), "{err}");
    }
}
