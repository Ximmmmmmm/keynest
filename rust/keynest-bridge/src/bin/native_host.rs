//! `keynest-native-host`：浏览器与 KeyNest 之间的中继进程。
//!
//! 它做的事情很少，刻意如此：
//!
//! ```text
//! stdin  ──读帧──► 校验长度 ──► 加密管道 ──► GUI
//! stdout ◄─写帧──  原样转发   ◄── 加密管道 ◄── GUI
//! ```
//!
//! **它不解析命令、不解密密码库、不认主密码。** 命令校验与锁定门禁都在
//! GUI 侧（`server::serve`）完成，这样即使这个进程被替换，
//! 攻击者拿到的也只是一条"需要 GUI 已解锁且要过认证"的通道。
//!
//! 唯一属于它的判断是：帧长度上限 + 连接失败就退出。

use std::io::{self, Write};
use std::process::ExitCode;

use keynest_bridge::framing::{read_frame, write_frame};
use keynest_bridge::pipe::connect_client;
use keynest_bridge::BridgeError;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(BridgeError::Closed) => ExitCode::SUCCESS,
        Err(e) => {
            // 只写错误码与描述，绝不写消息内容
            let _ = writeln!(io::stderr(), "keynest-native-host: {}", e.code());
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), BridgeError> {
    // 先连 GUI：连不上立刻退出，让浏览器显示"扩展未连接"，
    // 而不是挂在那里等一个永远不会来的响应。
    let mut pipe = connect_client()?;

    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let from_browser = match read_frame(&mut stdin) {
            Ok(f) => f,
            Err(BridgeError::Closed) => return Ok(()), // 浏览器关闭了端口
            Err(e) => return Err(e),
        };

        // 原样转给 GUI。长度校验已在 read_frame 里做过。
        write_frame(&mut pipe, &from_browser)?;

        let from_gui = read_frame(&mut pipe)?;
        write_frame(&mut stdout, &from_gui)?;
    }
}

/// 供测试引用的占位：确认标准错误里不会出现这些词。
#[cfg(test)]
mod tests {
    #[test]
    fn binary_has_no_password_logging() {
        // 静态检查：本文件不得出现把消息内容写进标准输出的调用。
        // 注意：如果把 "print" + "ln!" 直接写成字面量，测试会匹配到自己，
        // 所以这里拆开拼。
        let src = include_str!("native_host.rs");
        let needles = [
            format!("print{}", "ln!"),
            format!("pr{}!", "int"),
            format!("d{}!", "bg"),
        ];
        for bad in needles {
            assert!(
                !src.contains(&bad),
                "native host 不应使用 {bad}，否则可能把消息内容写进日志"
            );
        }
    }
}
