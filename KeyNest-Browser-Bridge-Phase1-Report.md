# KeyNest 浏览器桥 · 阶段 1 完成报告

> 分支：`feat/browser-bridge`
> 基线：`main` = `09b870d`（v0.4.3 未受任何影响）
> 日期：2026-11-02
> 状态：**阶段 1 完成，等待人工审查。未进入阶段 2。**

---

## 1. 新增文件

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `rust/keynest-bridge/Cargo.toml` | 33 | 新 crate 定义 |
| `rust/keynest-bridge/src/lib.rs` | 33 | 模块导出与"不做什么"声明 |
| `rust/keynest-bridge/src/limits.rs` | 75 | 全部上限常量（含编译期自洽断言） |
| `rust/keynest-bridge/src/framing.rs` | 141 | Native Messaging 4 字节长度前缀编解码 |
| `rust/keynest-bridge/src/error.rs` | 130 | 错误类型 + 稳定错误码 |
| `rust/keynest-bridge/src/protocol.rs` | 322 | 命令白名单、请求/响应、payload 校验 |
| `rust/keynest-bridge/src/auth.rs` | 340 | 握手、HKDF 派生、会话 AEAD |
| `rust/keynest-bridge/src/server.rs` | 470 | 握手 + 请求循环 + 锁定门禁 + 限流 |
| `rust/keynest-bridge/src/pipe.rs` | 216 | Windows Named Pipe 服务端/客户端 |
| `rust/keynest-bridge/src/bin/native_host.rs` | 76 | Native Host 二进制（stdin/stdout 中继） |
| `rust/keynest-core/tests/forward_compat.rs` | 72 | **前向兼容性实验**（决策 1 的证据） |
| `docs/browser-integration-architecture.md` | 559 | 阶段 0 文档 + 决策记录 + 第 13 节兼容性结论 |
| `KeyNest-Browser-Bridge-Phase1-Report.md` | 本文件 | — |

## 2. 修改文件

| 文件 | 改动 |
| --- | --- |
| `rust/Cargo.toml` | workspace 成员增加 `keynest-bridge` |

**没有修改**任何 `keynest-core` 的加密/存储代码，没有修改 `keynest-egui` 的任何文件。

## 3. 新增依赖及理由

| 依赖 | 版本 | 用途 | 许可证 | 维护 | 新增攻击面 | 能否标准库替代 |
| --- | --- | --- | --- | --- | --- | --- |
| `hkdf` | 0.12 | RFC 5869 密钥派生 | MIT/Apache-2.0 | RustCrypto，活跃 | 极小（纯计算，无 I/O） | 否（自己写 HKDF 属于自造密码学） |
| `chacha20poly1305` | 0.10 | 会话加密 | MIT/Apache-2.0 | RustCrypto，活跃 | **无新增**：core 已在用同一个 crate |
| `hmac` / `sha2` | 0.12 / 0.10 | 身份认证 | MIT/Apache-2.0 | RustCrypto，活跃 | **无新增**：已被 core 的 TOTP 引入 |
| `windows` | 0.58 | Named Pipe | MIT/Apache-2.0 | Microsoft | **无新增**：core 已在用 |

**唯一真正新增的下载是 `hkdf`**（它又依赖已在树中的 `hmac`/`sha2`）。
没有引入 HTTP 客户端、没有引入 TLS 库、没有引入异步运行时。

## 4. Native Messaging 协议

```
[4 字节小端长度 N][N 字节 UTF-8 JSON]
```

| 约束 | 值 | 实现位置 |
| --- | --- | --- |
| 单帧上限 | 1 MiB | `limits::MAX_MESSAGE_BYTES` |
| 超限行为 | **在读入前拒绝**（先查长度再分配） | `framing::read_frame` |
| 空帧 | 拒绝 | 同上 |
| 截断帧 | 报 `Malformed`，不 panic | 同上 |
| EOF | 视为正常关闭（`Closed`） | 同上 |

请求信封：

```jsonc
{ "v":1, "id":"...", "cmd":"vault.query", "session":"...", "payload":{...} }
```

**未知字段直接拒绝**（`deny_unknown_fields`），不做宽容解析。

命令白名单共 6 条：`hello` / `status` / `vault.query` / `vault.fill` / `vault.save` / `vault.conflict`。

## 5. Named Pipe ACL

| 项 | 实现 |
| --- | --- |
| 路径 | `\\.\pipe\keynest-bridge-v1` |
| SDDL | `D:P(A;;GA;;;OW)` —— DACL 受保护，仅授予 Owner Rights |
| 远程连接 | `PIPE_REJECT_REMOTE_CLIENTS` |
| 首实例保护 | `FILE_FLAG_FIRST_PIPE_INSTANCE`（防止他人抢占管道名做假服务端） |
| 实例数 | 1 |
| 模式 | `PIPE_TYPE_MESSAGE \| PIPE_READMODE_MESSAGE`（保留消息边界） |
| TCP / HTTP | **完全没有**。crate 内无 socket 代码 |

## 6. 握手与会话加密

```
服务端 → 客户端： challenge(32B CSPRNG)
客户端 → 服务端： client_nonce(32B) ‖ HMAC-SHA256(shared_secret, challenge‖client_nonce)
双方各自：        HKDF-SHA256(salt = challenge‖client_nonce, ikm = shared, info = "keynest-bridge-v1") → 32B 会话密钥
之后每条消息：     nonce(24B 随机) ‖ XChaCha20-Poly1305 密文，AAD = 单调序号(8B LE)
```

| 要求 | 落实 |
| --- | --- |
| 不自创算法 | HKDF / HMAC-SHA256 / XChaCha20-Poly1305 全部是标准算法，用成熟实现 |
| 防重放 | 双向独立单调序号；重复密文或乱序直接判 `Replay` |
| nonce 不重用 | 每条消息 24 字节随机（XChaCha 的安全余量足够） |
| 常量时间比较 | `verify_proof` 手写 XOR 累积比较，无提前返回 |
| 会话过期 | `SESSION_TTL_SECS = 1800`，过期返回 `NoSession` |
| 序号溢出 | `checked_add`，溢出即断开重连（**不静默回绕**） |
| 密钥擦除 | `Zeroizing<[u8;32]>`，`Debug` 手写脱敏 |

### 必须说清的限制

**会话加密不等于防住同用户恶意软件。** 同一 Windows 用户下的进程可以读进程内存、
可以读密钥文件、可以 hook。本设计解决的是"管道传输路径上被动可读"，
不解决"本机已被攻破"。这一条会写进 SECURITY.md。

## 7. 锁定状态保护

判定顺序在 `server::handle_one` 里固定为：

```
解析 JSON → 版本/命令/长度校验 → 锁定门禁 → 业务
```

锁定门禁在业务**之前**，所以锁定时连"这个条目是否存在"都不会泄漏。
`hello` 与 `status` 在锁定时仍可用（扩展需要它们显示"KeyNest 已锁定"）。

`VaultOps` trait 是唯一出口，由 GUI 实现——**本 crate 里没有任何代码能打开 vault.dat**。

## 8. 身份验证测试

| 测试 | 结果 |
| --- | --- |
| `handshake_accepts_correct_proof` | ✅ 通过 |
| `handshake_rejects_wrong_secret` | ✅ 通过 |
| `handshake_rejects_tampered_nonce` | ✅ 通过 |
| `end_to_end_wrong_secret_aborts_before_any_request` | ✅ 通过（且断言握手失败后服务端**不再写任何帧**） |
| `different_handshakes_derive_different_keys` | ✅ 通过 |

## 9. 畸形消息测试

| 测试 | 结果 |
| --- | --- |
| `oversized_payload_is_rejected_before_allocation` | ✅ |
| `lying_length_prefix_is_rejected_without_allocating`（声明 4 GiB） | ✅ |
| `truncated_frame_is_malformed_not_panic` | ✅ |
| `empty_frame_is_rejected` | ✅ |
| `eof_at_boundary_is_reported_as_closed` | ✅ |
| `malformed_json_is_rejected` | ✅ |
| `unknown_field_is_rejected_not_ignored` | ✅ |
| `unknown_command_is_rejected` | ✅ |
| `version_mismatch_is_rejected` | ✅ |
| `oversized_field_is_reported_by_name_only`（错误信息不含密码内容） | ✅ |

## 10. 重放测试

| 测试 | 结果 |
| --- | --- |
| `replaying_the_same_ciphertext_is_rejected` | ✅ 同一密文第二次必然 `Replay` |
| `out_of_order_delivery_is_rejected` | ✅ 跳过序号被拒 |
| `tampered_ciphertext_is_rejected` | ✅ 翻转末字节即失败 |
| `nonces_are_unique_across_messages` | ✅ 64 条消息无重复 nonce |

## 11. 超时与断连

| 项 | 实现 | 测试状态 |
| --- | --- | --- |
| 会话 TTL（30 min） | 循环内检查，超时 `NoSession` | ⚠️ **NOT TESTED**（需要 30 分钟或注入时钟，未做） |
| 限流（300 req/min） | 滑动窗口 | ✅ 单元测试 `rate_limiter_blocks_after_limit` |
| 单请求超时（3 s） | 常量已定义 | ⚠️ **NOT TESTED**：需要超时看门狗线程，阶段 1 未接 |
| 浏览器断开 | `read_frame` 返回 `Closed` → 正常退出 | ✅ `eof_at_boundary_is_reported_as_closed` |
| 解密失败 | 回一条错误后**立即结束会话** | ✅ 由 `serve` 逻辑保证；无独立测试 |

**明确标注：`REQUEST_TIMEOUT_MS` 与 `HANDSHAKE_TIMEOUT_MS` 目前只是常量，
尚未有执行它们的代码。** 这是阶段 2 接 GUI 时要做的事。

## 12. 现有功能回归

```
cargo test --workspace
  keynest-bridge    38 + 1
  keynest-core     121 + 2（含新增 forward_compat）
  core 集成          6 + 6
  keynest-egui      20
  ─────────────────────
  合计 194 通过，0 失败
```

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | ✅ 通过 |
| `cargo clippy --workspace --all-targets -D warnings` | ✅ 0 问题 |
| 密码库格式 | **未改动**（v1/v2/v3 代码一行未碰） |
| `v0.4.3` Tag / Release | 未触碰 |
| 用户真实密码库 | 未访问 |

## 13. 尚未实现（阶段 2 及以后）

- ❌ GUI 侧管道服务端接线（`VaultOps` 的 GUI 实现）
- ❌ 请求超时看门狗、握手超时
- ❌ 浏览器扩展（MV3、SW、content script）
- ❌ 登录表单检测、自动填充
- ❌ 自动保存 / 密码更新提示
- ❌ CSV 导入预览 UI
- ❌ 冲突裁决（依赖决策 1 的方案）
- ❌ Native Messaging 注册表安装器
- ❌ `Entry.rev`（**等你选方案 A/B/C**）

## 14. 未验证事项（NOT TESTED）

| 项 | 为什么没测 |
| --- | --- |
| **真实 Chrome / Edge 连接** | 扩展尚未编写。本报告里所有"端到端"都是**内存中的协议往返**，不是浏览器连接 |
| 真实 Named Pipe 往返 | 需要 GUI 侧服务端接线；目前 `pipe.rs` 只在编译层面验证 |
| 管道 ACL 的实际效果（另一用户连不上） | 需要第二个 Windows 账户，未做 |
| 30 分钟会话过期 | 时间成本 |
| 并发/压力 | 未做 |
| 安装器注册表写入与回滚 | 阶段 1 不含安装器 |

**绝不把上述任何一项描述为"已通过"。**

## 15. 提交建议

```
feat(bridge): add authenticated native messaging host (phase 1)

- 新增 keynest-bridge crate：帧编解码、命令白名单、HMAC 握手、
  HKDF 派生、XChaCha20-Poly1305 会话加密、Windows Named Pipe
- server 层只通过 VaultOps trait 访问数据，本 crate 无法打开 vault.dat
- 锁定门禁置于业务之前，状态泄漏最小化
- 新增 forward_compat 测试，证明旧程序会丢弃未知字段（决策 1 依据）
```

**分支 `feat/browser-bridge` 尚未提交，等审查。**
