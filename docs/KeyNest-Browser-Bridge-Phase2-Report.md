# KeyNest 浏览器集成 · 阶段 2 报告

> 分支：`feat/browser-bridge` · 基线 `main` = `09b870d` · v0.4.3 Tag 未动
> 日期：2026-11-02
> 状态：**阶段 2 完成，等待人工审查。未进入阶段 3。**

---

## 0. 一句话结论

桥接层从"能编译的协议库"变成了**真的能跑**：超时有了执行路径、密钥有了落盘与轮换、
GUI 侧接线完成、MV3 扩展写好。但**Chrome / Edge 的真实连接一次都没跑过**——
那需要在你机器上写注册表并手动加载扩展，我没有擅自执行。

---

## 1. 实际修改文件

### 新增（Rust）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `rust/keynest-bridge/src/watchdog.rs` | 214 | 请求超时看门狗 + 截止时间守卫 |
| `rust/keynest-bridge/src/keyfile.rs` | 218 | 共享密钥的生成/落盘/轮换/撤销（含 Windows DACL） |
| `rust/keynest-egui/src/bridge/mod.rs` | 331 | GUI 侧服务线程 + `VaultProxy` 通道桥 |
| `rust/keynest-egui/src/bridge/origin.rs` | 176 | origin 规范化（与 JS 侧同规则） |

### 修改

| 文件 | 改动 |
| --- | --- |
| `rust/keynest-bridge/src/server.rs` | 超时执行路径（握手截止 + 每请求 arm/disarm）；`fill` 改返回 `Zeroizing<String>` |
| `rust/keynest-bridge/src/error.rs` | 新增 `Timeout` 变体与 `TIMEOUT` 错误码 |
| `rust/keynest-bridge/src/lib.rs` | 注册新模块；转发 `serde_json` 避免下游重复依赖 |
| `rust/keynest-egui/Cargo.toml` | 依赖 `keynest-bridge`（**带 version**，否则 cargo-deny 判 wildcard） |
| `rust/keynest-egui/src/lib.rs` | 注册 `bridge` 模块 |
| `rust/keynest-egui/src/app.rs` | 字段 `bridge`；解锁后 `start()`、锁定后 `stop()`；`logic()` 里 `pump_bridge()` + `bridge_query` / `bridge_fill` / `bridge_save` |

### 新增（扩展）

```
browser-extension/
├── manifest.json                  MV3，最小权限
├── package.json                   仅为 node --test 的 ESM 解析
├── background/service-worker.js   唯一持有 nativePort
├── content/content-script.js      只做表单识别与写值
├── popup/{popup.html,popup.js,popup.css}
├── lib/origin.js                  与 Rust 同规则的 origin 规范化
└── tests/origin.test.js           12 项
```

### 新增（脚本）

`scripts/register-native-host-dev.ps1` —— **开发用**注册脚本（UTF-8 BOM，否则 PS 5.1 解析失败）。

---

## 2. 关键架构与数据流

```
popup（特权 UI，唯一能发起 fill）
   │ chrome.runtime.sendMessage
   ▼
service-worker（唯一持有 nativePort，唯一能 connectNative）
   │ Native Messaging（4B LE 长度 + JSON）
   ▼
keynest-native-host.exe（纯中继：不解析命令、不解密）
   │ 加密命名管道（握手 + AEAD + 单调序号）
   ▼
keynest-egui（持有 Vault 与 DEK，pump_bridge 在 UI 线程执行）
   │ keynest-core API
   ▼
vault.dat
```

**填充时的两次独立校验**：

1. `service-worker` 侧：从 `chrome.tabs.get(tabId)` 取**浏览器给的 URL**（不信任网页传来的任何地址），规范化 origin，必须 `https://`；
2. `keynest-egui` 侧：重新检查解锁状态、条目存在、`entry.origin == 请求 origin`。

任何一侧不满足都拒绝，不存在"缓存里查到过就放行"。

---

## 3. 认证密钥管理

| 项 | 实现 |
| --- | --- |
| 位置 | `<数据目录>/bridge.key`（默认 `%LOCALAPPDATA%\KeyNest\`） |
| 内容 | 32 字节原始 CSPRNG（不是 base64、不是文本） |
| 生成 | 首次 `BridgeService::start()` 时 `load_or_create` |
| 写入 | `.tmp` → `sync_all` → `rename`，崩溃不留半个密钥 |
| 权限 | Windows：SDDL `D:P(A;;GA;;;OW)` 收紧到当前用户 |
| 轮换 | `keyfile::generate()` 覆盖写，旧密钥立即失效 |
| 撤销 | `keyfile::revoke()` 删文件，下次握手重新生成 |
| 长度异常 | 直接报错，**不猜测、不凑合** |

**如实说明**：同用户恶意进程能读这个文件。它防的是别的用户与"GUI 未运行时的伪造连接"，
不防同用户恶意软件。这条已写进代码注释与本文档。

---

## 4. Native Messaging framing 兼容性

| 项 | 结论 | 证据等级 |
| --- | --- | --- |
| 长度前缀 | 4 字节 **小端** u32 | 代码 `framing::encode` 用 `to_le_bytes`；目标平台 Windows x64 为小端，与 Chromium `native_message_host` 的原生字节序一致 |
| 单帧上限 | 1 MiB（收得更紧） | `limits::MAX_MESSAGE_BYTES` |
| 超限处理 | **分配前拒绝**（先查长度） | `read_frame`；测试 `lying_length_prefix_is_rejected_without_allocating` |
| 空帧/截断 | 拒绝，不 panic | 3 项测试 |
| stdout 纪律 | 只写协议帧 | `native_host.rs` 全文仅 `write_frame(&mut stdout, ...)`；诊断只走 `stderr` 且只写错误码 |

**⚠️ 真实浏览器验证：NOT TESTED。** 上述全部是代码与规格对照，没有一次真实的
Chrome/Edge ↔ Host 往返。

---

## 5. Named Pipe 真实测试结果

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 编译（Windows 目标） | **PASS** | `cargo build --workspace` |
| 单元逻辑（协议层） | **PASS** | 50 项 bridge 测试 |
| **真实管道往返** | **BLOCKED** | 需要 GUI 已解锁才能启动服务；解锁需要主密码，我不会用你的真实密码做自动化测试 |
| ACL 实际效果（另一用户被拒） | **NOT TESTED** | 需要第二个 Windows 账户 |
| 拒绝远程客户端 | **NOT TESTED** | 需要另一台机器 |
| 单实例（第二个客户端 busy） | **NOT TESTED** | 需要并发客户端 |

`pipe.rs` 在 Windows 下能编译、能创建实例，但**"能创建"不等于"验证过"**。

---

## 6. Chrome 测试结果

| 用例 | 状态 |
| --- | --- |
| 扩展安装（开发者模式） | **NOT TESTED** |
| Native Host 连接 | **NOT TESTED** |
| GUI 未启动时的行为 | **NOT TESTED** |
| GUI 已锁定的行为 | **NOT TESTED** |
| 解锁后查询条目 | **NOT TESTED** |
| 用户主动点击填充 | **NOT TESTED** |
| HTTP 页面拒绝 | **NOT TESTED** |
| HTTPS 精确 origin 匹配 | **NOT TESTED** |
| 子域不混淆 | **NOT TESTED**（规则有单元测试，浏览器行为未验） |
| 跨站填充拒绝 | **NOT TESTED** |
| iframe 隔离 | **NOT TESTED** |
| 网页伪造消息 | **NOT TESTED** |

**原因**：真实测试需要
① 在本机写 HKCU 注册表（`register-native-host-dev.ps1`），
② 手动在 `chrome://extensions` 加载解包扩展，
③ 用真实浏览器打开登录页。
其中 ① 会改动你机器的注册表，**未经你同意我不会执行**。

---

## 7. Edge 测试结果

与 Chrome 完全一致：**全部 NOT TESTED**。Edge 同为 Chromium，扩展 API 兼容，
但"应该兼容"不是"验证过"。

---

## 8. 安全测试结果

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 恶意网页伪造消息 | **部分 PASS** | SW 用 `sender.tab` 区分：无 tab 才视为特权 UI；`fill`/`query` 对 content script 返回 `PRIVILEGED_ONLY`（代码路径存在，**无真实浏览器验证**） |
| 未授权扩展连接 | **PASS（设计）** | `allowed_origins` 只登记显式传入的 ID；脚本拒绝无 ID / 非法 ID 调用（3 项守卫测试通过） |
| 非法 origin | **PASS** | `origin::normalize` 12 项测试：`javascript:` / `file:` / `chrome:` / `mailto:` 全拒绝 |
| 跨站自动填充 | **PASS（单元）** | 精确 origin 比较；`example.com.evil.test` ≠ `example.com` 有断言 |
| 恶意 iframe | **部分** | `all_frames: false` + `frameId: 0` 限定；跨域 iframe 填充 **NOT TESTED** |
| 超大消息 | **PASS** | 分配前拒绝 |
| 重复请求 / 限流 | **PASS（单元）** | 滑动窗口 300/min；`rate_limiter_blocks_after_limit` |
| 重放旧请求 | **PASS** | 单调序号，重放/乱序/篡改各 1 项测试 |
| KeyNest 锁定后请求密码 | **PASS（单元）** | 锁定门禁在业务之前；端到端测试断言 `VAULT_LOCKED` |
| KeyNest 崩溃或退出 | **NOT TESTED** | 需要真实运行 |
| Native Host 异常退出 | **部分** | `onDisconnect` 清理 inflight；**无浏览器验证** |
| Named Pipe 权限错误 | **NOT TESTED** | 需要第二用户 |
| 日志出现密码 | **PASS（静态）** | 全链路无 `println!/dbg!`（有自检测试）；错误信息只带字段名与上限 |
| 扩展存储出现密码 | **PASS（代码审查）** | 无 `chrome.storage` / `localStorage` / `IndexedDB` 写入；密码只在局部变量 |
| 密码库格式兼容 | **PASS** | `vault.rs` 一行未改；121 项 core 测试全过 |
| 明文密码内存生命周期 | **PASS（类型级）** | `fill` 返回 `Zeroizing<String>`，离开作用域即擦除 |

---

## 9. 未完成事项

| 项 | 原因 |
| --- | --- |
| 真实 Chrome/Edge 端到端 | 需要注册表写入 + 手动加载扩展，等授权 |
| 真实管道往返 | 需要 GUI 解锁 |
| `vault.save`（自动保存） | 阶段 3；当前明确返回「尚未启用」，**不写半成品数据** |
| 冲突裁决 | 阶段 5；`conflicts` 目前回空数组 |
| HTTP 逐站授权 UI | 当前策略直接拒绝 HTTP，UI 未做 |
| 正式安装器 | 等扩展 ID 由商店分配（决策 5） |
| `Entry.rev` | 决策 1 选方案 A，本阶段不实现 |
| 图标资源 | 未提供 `icons/`（加载解包扩展不需要，商店上架时需要） |

---

## 10. Git 状态

```
分支：feat/browser-bridge
基线：main = 09b870d（未动）
v0.4.3 Tag：2bd390e（未动）
阶段 1 提交：8acffcc
阶段 2 提交：见下方（本次）
工作区：干净
未推送（不 force push、不改历史、不合并 main）
```

---

## 11. 风险与后续建议

| 风险 | 等级 | 建议 |
| --- | --- | --- |
| **从未在真实浏览器验证** | **高** | 下一步必须先做真实 Chrome 冒烟，否则"能用"只是纸面结论 |
| 注册表写入需要授权 | 中 | 明确由你执行 `register-native-host-dev.ps1`，或授权我执行 |
| 扩展 ID 与 allowed_origins 绑死 | 中 | 开发者模式加载后 ID 稳定；换路径会变 ID，需重新注册 |
| `all_frames: false` 可能漏掉同页 iframe 登录框 | 低 | 阶段 3 再评估，需配合站点授权 |
| 同用户恶意进程 | 中 | 已如实文档化，不夸大 |
| 密码经 SW 传给 content script | 中 | 这是 MV3 的固有形态（content script 必须拿到值才能填）。缓解：填充后立即 `window.close()`、不落任何存储、不写日志 |

**下一步建议顺序**：

1. 你手动加载扩展 + 跑注册脚本，做一次真实 Chrome 冒烟（我做不了）
2. 根据冒烟结果修 MV3 细节（很可能会遇到 `sender.tab` 判定、CSP、SW 生命周期问题）
3. 再进阶段 3（自动保存）

---

## 12. 本次实测数字

```
cargo test --workspace    222 通过（bridge 50 + core 135 + egui 36 + 集成 6/6）
cargo fmt --all --check   PASS
cargo clippy -D warnings  0 问题
cargo deny check          advisories/bans/licenses/sources 全绿
node --test               12 通过（origin 规范化）
native host 二进制         227,840 字节
GUI 冒烟                  启动正常、响应正常、正常退出
真实密码库                 size/mtime/md5 前后完全一致（未触碰）
锁定时桥接                 ✓ 未启动（无 bridge.key 生成）
```

**过程中修掉的真实缺陷**：

1. `REQUEST_TIMEOUT_MS` / `HANDSHAKE_TIMEOUT_MS` 在阶段 1 **从未被使用**——现在是真执行路径
2. 握手超时用「elapsed > 上限」在时钟粒度粗时会误判，改为「now >= 截止时刻」
3. 填充时 `setValue(user, '')` 会**清空用户已输入的账号**，改为 username 缺省时不写
4. `keynest-bridge` 依赖缺 `version` → cargo-deny 判 wildcard → bans FAILED
5. `register-native-host-dev.ps1` 无 BOM 导致 PS 5.1 解析失败（中文注释触发）
