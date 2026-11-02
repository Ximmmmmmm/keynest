//! Windows 命名管道：服务端（GUI）与客户端（Native Host）。
//!
//! # 安全要点
//!
//! 1. **显式 DACL**：只授予当前用户，不给 Everyone / ANONYMOUS。
//! 2. **拒绝远程客户端**：`PIPE_REJECT_REMOTE_CLIENTS`。
//! 3. **单实例**：`nMaxInstances = 1`，第二个客户端立刻拿到 `PIPE_BUSY`。
//! 4. 管道名**不是身份凭证**——认证在 [`crate::auth`] 里做。

/// 管道名。版本号进名字，避免新旧版本互相误连。
pub const PIPE_NAME: &str = r"\\.\pipe\keynest-bridge-v1";

#[cfg(windows)]
pub use imp::{accept_one, connect_client};

#[cfg(not(windows))]
pub use stub::{accept_one, connect_client};

#[cfg(windows)]
mod imp {
    use std::io::{self, Read, Write};

    use super::PIPE_NAME;
    use crate::error::BridgeError;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_PIPE_BUSY, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, NAMED_PIPE_MODE,
        PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
    };

    use crate::limits::MAX_MESSAGE_BYTES;

    /// `CreateNamedPipeW` 的 dwOpenMode 位。crate 没导出这个常量，按 Win32 定义写死。
    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    /// FILE_FLAG_FIRST_PIPE_INSTANCE：保证当前用户只可能有一个桥接实例，
    /// 防止别的进程抢先占住管道名做假服务端。
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    /// 拒绝远程客户端（Windows 7+）。
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 构造只允许当前用户的安全描述符。
    ///
    /// SDDL: `D:P(A;;GA;;;OW)`
    /// - `D:P` DACL 且受保护（不继承父对象权限）
    /// - `A;;GA;;;OW` 允许完全访问给 Owner Rights
    ///
    /// 用 `OW` 而不是硬编码用户名：同一份代码在任何用户名下都正确。
    fn security_attributes() -> Result<(*mut core::ffi::c_void, SECURITY_ATTRIBUTES), BridgeError> {
        let sddl = wide("D:P(A;;GA;;;OW)");
        let mut sd = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
            .map_err(|e| BridgeError::Io(format!("安全描述符构造失败: {e}")))?;
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        Ok((sd.0, sa))
    }

    struct PipeHandle(HANDLE);

    impl Drop for PipeHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    impl Read for PipeHandle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut read = 0u32;
            unsafe {
                ReadFile(self.0, Some(buf), Some(&mut read), None)
                    .map_err(|e| io::Error::other(e.to_string()))?;
            }
            Ok(read as usize)
        }
    }

    impl Write for PipeHandle {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut written = 0u32;
            unsafe {
                WriteFile(self.0, Some(buf), Some(&mut written), None)
                    .map_err(|e| io::Error::other(e.to_string()))?;
            }
            Ok(written as usize)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// 服务端：创建管道并阻塞等待一个客户端。
    pub fn accept_one() -> Result<impl Read + Write, BridgeError> {
        let name = wide(PIPE_NAME);
        let (sd_ptr, sa) = security_attributes()?;

        let open_mode = FILE_FLAGS_AND_ATTRIBUTES(
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | PIPE_REJECT_REMOTE_CLIENTS,
        );
        let pipe_mode =
            NAMED_PIPE_MODE(PIPE_TYPE_MESSAGE.0 | PIPE_READMODE_MESSAGE.0 | PIPE_WAIT.0);

        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                open_mode,
                pipe_mode,
                1,
                MAX_MESSAGE_BYTES as u32,
                MAX_MESSAGE_BYTES as u32,
                0,
                Some(&sa),
            )
        };

        unsafe {
            // HLOCAL 是新类型，必须显式包一层
            let _ = LocalFree(HLOCAL(sd_ptr));
        }

        if handle.is_invalid() {
            return Err(BridgeError::Io(format!(
                "创建管道失败: {}",
                windows::core::Error::from_win32()
            )));
        }
        let pipe = PipeHandle(handle);

        unsafe {
            match ConnectNamedPipe(pipe.0, None) {
                Ok(()) => {}
                // ERROR_PIPE_CONNECTED：客户端在 ConnectNamedPipe 之前就连上了，
                // 这是竞态下的正常结果，不是错误。
                Err(e) if e.code().0 == 0x8007_00E7u32 as i32 => {}
                Err(e) => return Err(BridgeError::Io(format!("等待客户端失败: {e}"))),
            }
        }
        Ok(pipe)
    }

    /// 客户端：连接 GUI 建立的管道。GUI 没开或没监听时立刻失败。
    pub fn connect_client() -> Result<impl Read + Write, BridgeError> {
        let name = wide(PIPE_NAME);
        let handle = unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        match handle {
            Ok(h) if !h.is_invalid() => Ok(PipeHandle(h)),
            Ok(_) => Err(BridgeError::Io("管道句柄无效".into())),
            Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() => {
                Err(BridgeError::Io("GUI 忙或未就绪".into()))
            }
            Err(e) => Err(BridgeError::Io(format!("连接管道失败: {e}"))),
        }
    }

    /// 断开当前实例，允许下一个客户端连入。
    ///
    /// 目前 GUI 侧尚未接线（阶段 2 才建起连接循环），先保留并标注。
    #[allow(dead_code)]
    pub fn disconnect(pipe: HANDLE) {
        unsafe {
            let _ = DisconnectNamedPipe(pipe);
        }
    }
}

/// 非 Windows：管道不可用，但协议/加密/测试仍可编译运行。
#[cfg(not(windows))]
mod stub {
    use super::*;
    use std::io;

    pub fn accept_one() -> Result<io::Cursor<Vec<u8>>, BridgeError> {
        Err(BridgeError::Unsupported)
    }

    pub fn connect_client() -> Result<io::Cursor<Vec<u8>>, BridgeError> {
        Err(BridgeError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_carries_protocol_version() {
        assert!(PIPE_NAME.contains("keynest-bridge"));
        assert!(PIPE_NAME.contains("v1"));
        assert!(PIPE_NAME.starts_with(r"\\.\pipe\"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_reports_unsupported() {
        assert!(matches!(accept_one(), Err(BridgeError::Unsupported)));
    }
}
