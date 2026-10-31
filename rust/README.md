# Rust 版（Tauri）

钥巢的 Rust 实现。界面完全复用 `src/renderer/`，主进程用 Rust 重写。

## 体积对比（实测）

| | Electron 版 | Tauri 版（debug） |
| --- | --- | --- |
| 可执行文件 | 200 MB（含 Chromium） | 20 MB |
| 安装包 | 98 MB | 见下方 release 构建 |
| 运行时 | 自带 Chromium | 系统 WebView2 |

## 已实现

| 模块 | 状态 |
| --- | --- |
| `keynest-core/vault` 加密仓库 | ✅ 与 Node 版双向兼容 |
| `keynest-core/password` 生成器 | ✅ |
| `browser/csv` CSV 解析与去重 | ✅ 含引号、BOM、CRLF、分号分隔 |
| `browser/discovery` CSV 自动发现 | ✅ 多文件合并、新鲜度判定 |
| `browser/export` 明文导出 | ✅ CSV 往返一致 |
| `browser/sqlite` 只读 SQLite 解析 | ✅ 自研，不依赖 C 编译器 |
| `browser/login_data` 浏览器扫描 + DPAPI | ✅ 进程内调用，无 PowerShell |
| `commands` 全部 IPC 命令 | ✅ 与 Electron 版 JSON 形状一致 |
| `state` 自动锁定 | ✅ |
| Tauri 窗口 | ✅ 启动验证通过 |

## 关键设计

**1. 格式双向兼容**

`vault.dat` 在 Node 与 Rust 之间可互换。靠三点保证：
- 文件结构逐字段一致
- AAD 的 JSON 字节一致（决定能否解开对方的文件）
- scrypt 参数一致

实测：Node 写的 2 条目库 Rust 能开，Rust 写的库 Node 能开。

**2. 不用 rusqlite**

`rusqlite` 的 `bundled` 特性要编译 SQLite C 源码，需要 cl.exe。
本机只有 MSVC 的 link.exe，所以自己实现了只读 SQLite 解析（`browser/sqlite.rs`），
只支持「遍历所有 BLOB 列」，足够读 `Login Data`。

**3. DPAPI 进程内调用**

Node 版靠 `execFileSync('powershell.exe', ...)`，每次约 300ms，密钥以 base64 字符串跨进程。
Rust 直接调 `CryptUnprotectData`，零子进程、零字符串中转。

**4. v20 依然读不了**

应用绑定加密的密钥由 `elevation_service` 保管，它校验调用方签名。
这是 Chrome 的设计，与实现语言无关。Rust 版和 Node 版结论相同。

## 构建

```bash
# 需要 MSVC 链接器（或 rust-lld）
export CARGO_BUILD_JOBS=16

cargo build -p keynest-app --release
cargo test
```

本机 `~/.cargo/config.toml` 配置：

```toml
[source.crates-io]
replace-with = "ustc"

[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"

[target.x86_64-pc-windows-msvc]
linker = "rust-lld.exe"
```

## 测试

21 项：core 5 + app 16。覆盖 AAD 形状、密码生成、CSV 引号/BOM/CRLF、
去重键、CSV 往返、SQLite 魔数校验。
