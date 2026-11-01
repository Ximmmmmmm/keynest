# 贡献指南

感谢你愿意参与。这是个小型项目，规则尽量少，但有几条是硬的。

---

## 先说清楚：这是个安全软件

改动会被几百个不认识的人用来存真实密码。因此：

- **安全优先于功能数量，数据安全优先于开发便利。**
- 不接受「为了通过测试而删掉测试」。
- 不接受「先合并、以后再补测试」。
- 不接受自研加密算法、硬编码密钥、用 Base64 冒充加密。
- 不接受未经独立审计却宣称「已审计」。

如果你不确定某个改动会不会削弱安全性，**先开 issue 讨论**，不要直接写一大坨 PR。

---

## 开发环境

```bash
# Rust 1.89+（用到标准库的 File::try_lock）
rustup toolchain install stable
rustup component add clippy rustfmt

cd rust
cargo build
cargo run -p keynest-egui        # 启动界面
```

可选但推荐：

```bash
cargo install cargo-deny          # 依赖审计
```

---

## 提交前必须全绿

```bash
cd rust
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
```

这四条与 CI 完全一致。本地过了、CI 挂了，通常是漏了某个 target——
`--all-targets` 会把示例与集成测试一起编进去，别只跑 `cargo test`。

---

## 代码约定

### 分层

- `keynest-core` **不许**依赖任何 UI / WebView / 网络库。它是纯逻辑。
- 界面状态只在 `keynest-egui/src/app.rs` 里迁移；`views/*` 只画界面并返回意图枚举。
- 新交互的固定套路见 [ARCHITECTURE.md](docs/ARCHITECTURE.md#6-意图intent模式)。

### 敏感数据

- 主密码、密钥、明文密码一律用 `Zeroizing` 或 `SecretKey` 包裹。
- 任何结构体都不要 `#[derive(Debug)]` 后直接包含秘密——手写 `Debug` 并打 `<redacted>`。
- 错误信息里不许拼接可能含秘密的原始数据。
- 新增的错误变体必须给 `code()` 一个稳定值。

### 磁盘与兼容

- 新增 `Entry` 字段必须带 `#[serde(default)]`，**并配一条「缺该字段的旧 JSON 仍可解析」的测试**。
- 改文件格式必须新增版本号，不许原地改语义。旧版本读取路径至少要保留一个大版本。
- 任何破坏性迁移都要：先备份 → 写入 → 用主密码重新打开验证 → 失败自动回滚。

### 测试

- 修 bug 先写一个会失败的测试，再修。
- 涉及解密的改动，至少要覆盖：正确密码、错误密码、文件被改、文件被截断。
- 新增界面交互，尽量把逻辑抽成纯函数放进 `app.rs`，那样能脱离渲染单测。

---

## 提交信息

用中文或英文都可以，标题一句话说清"做了什么"，正文说"为什么"。

```text
修复：导入时同名条目覆盖已有密码

import_entries 的去重键原来只比较标题，导致同名不同账号的记录互相覆盖。
改成「标题 + 账号」（忽略大小写），并补一条回归测试。
```

---

## Pull Request

- 一个 PR 做一件事。重构和功能分开。
- 描述里写清楚：**改了什么 / 为什么 / 怎么验证的**。
- 涉及界面的改动，附一张 `cargo run -p keynest-egui --example shots` 生成的截图。
- 涉及格式或迁移的改动，说明回滚方案。

---

## 文档

- 安全相关的说法必须能在源码里指到具体位置（文件 + 函数）。
- 不要写"银行级加密""军工级"这类词。
- 改了行为就同步更新 [README](README.md) / [SECURITY](SECURITY.md) / [ARCHITECTURE](docs/ARCHITECTURE.md)。
- 用户可感知的变更写进 [CHANGELOG](CHANGELOG.md)。

---

## 安全问题

**不要**在公开 issue 或 PR 里描述漏洞细节。见 [SECURITY.md](SECURITY.md)。

---

## 许可证

项目采用 MIT OR Apache-2.0 双许可。提交 PR 即表示你同意以这两个许可证分发你的贡献，
并且你有权这样做（例如不是从别处抄来的、不是雇主独占的代码）。
