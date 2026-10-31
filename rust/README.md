# Rust 核心（迁移中）

`keynest-core` 是钥巢主进程逻辑的 Rust 实现，与 Node 版**格式完全兼容**。

## 状态

| 模块 | 状态 |
| --- | --- |
| `vault` 加密仓库 | ✅ 已完成，双向兼容验证通过 |
| `password` 生成器与强度 | ✅ 已完成 |
| `error` 错误类型 | ✅ 已完成 |
| `browser` 浏览器导入 | ⬜ 待做 |
| `export` 明文导出 | ⬜ 待做 |
| `tauri` 窗口与 IPC | ⬜ 待做 |

## 兼容性验证

```bash
# Node 写 → Rust 读
node -e "..."   # 造 fixture
cargo run --example compat -- <vault.dat> <密码>

# Rust 写 → Node 读
cargo run --example write -- <vault.dat> <密码>
node -e "..."   # 用 src/main/vault.js 打开
```

两侧均验证通过，AAD 构造、scrypt 参数、AES-GCM 布局字节级一致。

## 构建环境

需要 MSVC 链接器。本机配置：

```toml
# ~/.cargo/config.toml
[target.x86_64-pc-windows-msvc]
linker = "rust-lld.exe"
```

`rust-lld` 是 Rust 自带的 LLVM 链接器，比 MSVC 的 `link.exe` 快，且不受 PATH 里 Git Bash 的 GNU `link` 干扰。

## 测试

```bash
cargo test
```

5 项通过：AAD 形状、密码长度、字符集选择、易混淆字符排除、强度递增。
