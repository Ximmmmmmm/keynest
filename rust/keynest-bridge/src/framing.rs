//! Native Messaging 的帧格式。
//!
//! ```text
//! [4 字节小端长度 N][N 字节 UTF-8 JSON]
//! ```
//!
//! 这是浏览器规定的格式，不能改。但读的一方必须自己防三件事：
//! 长度撒谎、长度过大、以及"读到一半对端挂了"。

use std::io::{self, Read, Write};

use crate::error::BridgeError;
use crate::limits::MAX_MESSAGE_BYTES;

/// 把正文编码成一帧。
pub fn encode(payload: &[u8]) -> Result<Vec<u8>, BridgeError> {
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err(BridgeError::MessageTooLarge {
            len: payload.len(),
            max: MAX_MESSAGE_BYTES,
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// 判断这个 IO 错误是不是「对端已经断开」。
///
/// Windows 命名管道在三种情况下会这样：
/// * `ERROR_BROKEN_PIPE`（109）：对端关闭了管道
/// * `ERROR_PIPE_NOT_CONNECTED`（233）：管道已经不存在
/// * `ERROR_NO_DATA`（232）：管道已结束
///
/// # 为什么第三种要靠消息文本判断
///
/// `ERROR_NO_DATA` 在 Windows 上是以 **HRESULT**（`0x8007006D`）形式返回的，
/// 不是 `GetLastError()` 的形式。`std::io::Error` 对它做了转换，
/// 结果是 `raw_os_error()` 返回 **`None`**、`kind()` 是 `Other`，
/// 错误消息是本地化的「管道已结束。」。
///
/// 所以只能同时看两种来源：
///   * `raw_os_error()` —— 覆盖 BROKEN_PIPE / PIPE_NOT_CONNECTED
///   * 消息里含 HRESULT —— 覆盖 NO_DATA
///
/// 消息匹配用 `contains` 而不是精确相等：系统语言不同，文本会变
/// （英文是 "The pipe has been ended."），但 HRESULT 那段十六进制是稳定的。
#[cfg(windows)]
fn is_pipe_disconnected(e: &io::Error) -> bool {
    if matches!(e.raw_os_error(), Some(109) | Some(232) | Some(233)) {
        return true;
    }
    // HRESULT 形式：0x8007006D == ERROR_NO_DATA
    let text = e.to_string();
    text.contains("0x8007006D") || text.contains("0x8007006E")
}

/// 非 Windows 平台：断开的典型表现是 `UnexpectedEof` 或连接被重置。
#[cfg(not(windows))]
fn is_pipe_disconnected(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
    )
}

/// 从流里读一帧。
///
/// 长度前缀先做上限检查**再**分配内存：否则一个声明 4 GiB 的恶意帧
/// 就能让进程直接 OOM，这比读不完更糟。
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, BridgeError> {
    read_frame_on_first_byte(reader, || {})
}

/// 与 [`read_frame`] 相同，但在**收到首个字节时**回调一次。
///
/// 服务端用它区分「客户端空闲」与「读帧进行中」：
/// 只有后者才需要帧读取超时保护（见 `server.rs` 的请求循环）。
pub fn read_frame_on_first_byte<R: Read>(
    reader: &mut R,
    on_first_byte: impl FnMut(),
) -> Result<Vec<u8>, BridgeError> {
    let mut len_buf = [0u8; 4];
    read_exact_on_first_byte(reader, &mut len_buf, on_first_byte)?;
    let len = u32::from_le_bytes(len_buf) as usize;

    if len > MAX_MESSAGE_BYTES {
        return Err(BridgeError::MessageTooLarge {
            len,
            max: MAX_MESSAGE_BYTES,
        });
    }
    if len == 0 {
        return Err(BridgeError::Malformed("空帧"));
    }

    let mut buf = vec![0u8; len];
    // 消息体阶段不再回调（首字节已经触发过）
    read_exact_or_eof(reader, &mut buf)?;
    Ok(buf)
}

/// 读到 0 字节表示对端正常关闭（EOF），这是**正常退出**路径，不是错误。
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<(), BridgeError> {
    read_exact_on_first_byte(reader, buf, || {})
}

/// 与 [`read_exact_or_eof`] 相同，但在**收到第一个字节后**回调一次。
///
/// 用途：让调用方知道"客户端真的开始发数据了"。
/// 服务端借此把「客户端空闲等待」与「读帧进行中」区分开——
/// 只有后者才该受帧读取超时约束（见 `server.rs`）。
///
/// 回调只触发一次；若对端在首字节之前就 EOF（`Closed`），回调不会执行。
pub fn read_exact_on_first_byte<R: Read>(
    reader: &mut R,
    buf: &mut [u8],
    mut on_first_byte: impl FnMut(),
) -> Result<(), BridgeError> {
    let mut filled = 0;
    let mut notified = false;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Err(BridgeError::Closed);
                }
                return Err(BridgeError::Malformed("帧被截断"));
            }
            Ok(n) => {
                if !notified {
                    notified = true;
                    on_first_byte();
                }
                filled += n;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            // 对端已经断开：当成正常关闭，而不是 IO 错误。
            //
            // 真实场景：浏览器扩展被禁用、用户关掉标签页、native host 崩溃——
            // 这些都会让管道读到 `ERROR_BROKEN_PIPE` / `ERROR_PIPE_NOT_CONNECTED`
            // 而不是干净的 EOF（读到 0 字节）。
            //
            // 不区分的话，服务端会把一次**正常的**连接结束报成 IO 错误：
            // 日志里出现误导性的错误，还可能让上层以为出了故障。
            Err(e) if is_pipe_disconnected(&e) => return Err(BridgeError::Closed),
            Err(e) => return Err(BridgeError::Io(e.to_string())),
        }
    }
    Ok(())
}

/// 写一帧并立刻 flush：Native Messaging 是请求-响应语义，
/// 不 flush 就是死等。
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> Result<(), BridgeError> {
    let bytes = encode(payload)?;
    writer
        .write_all(&bytes)
        .map_err(|e| BridgeError::Io(e.to_string()))?;
    writer.flush().map_err(|e| BridgeError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对端断开要当成**正常关闭**，不是 IO 错误。
    ///
    /// 浏览器扩展被禁用、用户关掉标签页、native host 崩溃——这些都会让
    /// 管道读到 `ERROR_BROKEN_PIPE` 而不是干净的 EOF。
    ///
    /// 不区分的话，服务端会把一次正常的连接结束报成 IO 错误：
    /// 日志里出现误导性的错误，还可能让上层以为出了故障。
    #[test]
    fn broken_pipe_is_reported_as_closed_not_io() {
        // 造一个「读的时候报破损管道」�� reader
        struct BrokenPipe;
        impl Read for BrokenPipe {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from_raw_os_error(109)) // ERROR_BROKEN_PIPE
            }
        }

        let err = read_frame(&mut BrokenPipe).unwrap_err();
        assert!(
            matches!(err, BridgeError::Closed),
            "对端断开应当是 Closed，实际: {err:?}"
        );
    }

    /// `ERROR_NO_DATA`（HRESULT 形式）也要被当成正常关闭。
    ///
    /// 它是实测最常遇到的：客户端进程退出后，服务端继续读管道，
    /// Windows 给的是 `0x8007006D`，而 `std::io::Error` 对它做了转换后
    /// **`raw_os_error()` 返回 `None`**——所以只能从消息文本里认。
    #[test]
    fn error_no_data_as_hresult_is_reported_as_closed() {
        // 造一个与 Windows 转换结果同形的错误
        let e = std::io::Error::other("管道已结束。 (0x8007006D)");
        assert!(
            is_pipe_disconnected(&e),
            "HRESULT 形式的 ERROR_NO_DATA 没被认出来"
        );
        // 同样要能通过 read_frame 走完整路径
        struct NoData;
        impl Read for NoData {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("管道已结束。 (0x8007006D)"))
            }
        }
        let err = read_frame(&mut NoData).unwrap_err();
        assert!(matches!(err, BridgeError::Closed), "实际: {err:?}");
    }

    /// 真正的 IO 错误**不能**被当成正常关闭。
    ///
    /// 把所有读错误都算成 Closed 的话，磁盘故障、权限问题这类真故障
    /// 会被静默吞掉——会话"正常结束"，但用户什么也没得到。
    #[test]
    fn real_io_error_is_still_io() {
        struct RealError;
        impl Read for RealError {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from_raw_os_error(5)) // ERROR_ACCESS_DENIED
            }
        }

        let err = read_frame(&mut RealError).unwrap_err();
        assert!(
            matches!(err, BridgeError::Io(_)),
            "真 IO 错误应当是 Io，实际: {err:?}"
        );
    }

    #[test]
    fn roundtrip_preserves_bytes() {
        let payload = br#"{"cmd":"status"}"#;
        let frame = encode(payload).unwrap();
        assert_eq!(&frame[..4], &(payload.len() as u32).to_le_bytes());
        let mut cursor = std::io::Cursor::new(frame);
        assert_eq!(read_frame(&mut cursor).unwrap(), payload);
    }

    #[test]
    fn oversized_payload_is_rejected_before_allocation() {
        let big = vec![b'a'; MAX_MESSAGE_BYTES + 1];
        assert!(matches!(
            encode(&big),
            Err(BridgeError::MessageTooLarge { .. })
        ));
    }

    #[test]
    fn lying_length_prefix_is_rejected_without_allocating() {
        // 声明 4 GiB，实际一个字节都没有。必须在分配前拒绝。
        let mut buf = Vec::new();
        buf.extend_from_slice(&u32::MAX.to_le_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(BridgeError::MessageTooLarge { .. })
        ));
    }

    #[test]
    fn truncated_frame_is_malformed_not_panic() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(b"abc"); // 只有 3 字节
        let mut cursor = std::io::Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(BridgeError::Malformed(_))
        ));
    }

    #[test]
    fn empty_frame_is_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(BridgeError::Malformed(_))
        ));
    }

    #[test]
    fn eof_at_boundary_is_reported_as_closed() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        assert!(matches!(read_frame(&mut cursor), Err(BridgeError::Closed)));
    }
}
