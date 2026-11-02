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
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, NAMED_PIPE_MODE,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    use crate::limits::MAX_MESSAGE_BYTES;

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
                // 先断开再关闭：管道实例被复用/重建时，Windows 要求
                // 先 DisconnectNamedPipe，否则后续客户端会拿到 BROKEN_PIPE。
                // 实测：缺这一步时第一次握手失败后，所有后续连接都连不上。
                let _ = DisconnectNamedPipe(self.0);
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

        // open mode 只能放 PIPE_ACCESS_* 与 FILE_FLAG_* 位。
        // 注意：PIPE_REJECT_REMOTE_CLIENTS 属于 **pipe mode**，不是 open mode——
        // 放错位置会让 CreateNamedPipeW 返回 ERROR_INVALID_PARAMETER(0x80070057)。
        //
        // **不要用 FILE_FLAG_FIRST_PIPE_INSTANCE**：它只允许创建一次实例，
        // 连接断开后重建会失败（名字已存在），服务从此永久不可用。
        // 唯一性由 nMaxInstances=1 + 单线程串行 accept 保证。
        let open_mode = FILE_FLAGS_AND_ATTRIBUTES(PIPE_ACCESS_DUPLEX.0);
        // **必须用字节模式（PIPE_TYPE_BYTE / PIPE_READMODE_BYTE）**，不能用消息模式。
        //
        // 消息模式下 ReadFile 要求一次读完整个消息，缓冲区偏小就返回
        // ERROR_MORE_DATA(0x800700EA)——而我们的 read_frame 是先读 4 字节长度
        // 再读正文，天然是分段读的。实测：消息模式下每次握手都在这一步断掉。
        //
        // 消息边界由我们自己的长度前缀协议提供，不需要管道再保证一遍。
        let pipe_mode = NAMED_PIPE_MODE(
            PIPE_TYPE_BYTE.0 | PIPE_READMODE_BYTE.0 | PIPE_WAIT.0 | PIPE_REJECT_REMOTE_CLIENTS.0,
        );

        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                open_mode,
                pipe_mode,
                1,
                MAX_MESSAGE_BYTES as u32,
                MAX_MESSAGE_BYTES as u32,
                // nDefaultTimeOut 必须 ≥ 1 毫秒。传 0 会被 Win32 判为
                // ERROR_INVALID_PARAMETER(0x80070057)——真实 Chrome 测试踩到过。
                1000,
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
                // ERROR_PIPE_CONNECTED：客户端在 ConnectNamedPipe 之前就连上了。
                // 这是竞态下的**正常结果**，必须放行——否则每次客户端抢先连接，
                // 服务端都会把这次连接当失败丢掉，浏览器侧只会看到 IO。
                //
                // 535 = 0x217，HRESULT 形式是 0x80070217。
                // （曾误写成 0x800700E7，那是 ERROR_MORE_DATA，永远匹配不上。）
                Err(e) if e.code().0 == 0x8007_0217u32 as i32 => {}
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
                // 命名管道客户端**不能**用 FILE_SHARE_NONE（0）——
                // 传 0 会直接返回 ERROR_INVALID_PARAMETER / 打开失败。
                // 管道本身是消息端点，共享模式对这里没有意义，给读写即可。
                FILE_SHARE_READ | FILE_SHARE_WRITE,
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
