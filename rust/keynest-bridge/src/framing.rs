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
