# KeyNest 浏览器集成 · 架构设计（阶段 0）

> 状态：**阶段 0 完成，已于 2026-11-02 按业主决策更新（见第 13 节）；阶段 1 已实现桥接层**
> 日期：2026-11-02
> 对应版本：KeyNest v0.4.3（`09b870d`）
> 本文所有的"现状"描述均来自读代码，凡是推测的地方都标了「推测」。

---

## 0. 一页结论

| 问题 | 结论 |
| --- | --- |
| 能不能直接读写 Chrome/Edge 内置密码库？ | **不能。** 官方扩展 API 没有这个能力。本设计不依赖、不假装拥有它。 |
| 那"集成"到底做什么？ | ① 导入浏览器导出的 CSV；② 扩展在网页上填充 **KeyNest 里**的密码；③ 网页登录后把新密码**存进 KeyNest**；④ 冲突检测与人工裁决。 |
| 谁是主库？ | **KeyNest。** 浏览器只是受控入口。 |
| 要不要改 vault.dat 格式？ | **不需要改密文格式。** 只需给 `Entry` / `Settings` 增加可选字段，靠 `#[serde(default)]` 保持旧库可读。 |
| 现阶段能不能开工写代码？ | 能，但要先回答第 10 节的 7 个决策。 |

---

## 1. 当前项目架构摘要（基于代码实测）

### 1.1 物理结构

```
rust/
├── Cargo.toml              workspace：members = keynest-core, keynest-egui
│                           release profile: strip + lto + opt-level="z"
│                           + panic=abort + codegen-units=1
├── keynest-core/           纯逻辑，无 UI 依赖
│   └── src/
│       ├── vault.rs        3,759 行：格式 v1/v2/v3、KDF、AEAD、Entry、备份
│       ├── portable.rs       753 行：CSV/JSON 导入导出
│       ├── secure.rs         Win32 剪贴板（含 Win+V 历史排除）+ 系统闲置
│       ├── keymem.rs         VirtualLock 密钥内存
│       ├── lockfile.rs       单实例锁（std::fs::File::try_lock）
│       ├── paths.rs          数据目录解析
│       ├── password.rs       生成器 + 强度估算
│       ├── totp.rs           RFC 6238
│       └── error.rs          VaultError（含稳定错误码）
└── keynest-egui/           egui 0.37 桌面端
    └── src/
        ├── app.rs          1,875 行：AppState 状态机、所有意图处理
        ├── views/          lock / main_view / edit / settings
        └── ui/             theme / icons / clipboard / fonts / winchrome
```

### 1.2 关键事实（会直接影响浏览器集成设计）

| 事实 | 影响 |
| --- | --- |
| `Vault` 把 DEK 与明文 `VaultData` **都放在 GUI 进程内存里** | 浏览器桥不能自己开库，必须借用**已解锁的 GUI 进程** |
| 单实例锁保证只有一个进程持有明文 | 天然排除了"第二个进程也解锁"的方案 |
| `Vault::unlock()` 需要主密码 | Native Host 绝不应该、也不会接触主密码 |
| 条目删除是**软删除**（`deleted_at`） | 浏览器若缓存 id，需要在删除后失效；回收站里恢复也要通知 |
| `Entry` 已有 `updated_at`、`password_changed_at` | 冲突检测有现成的时间戳可用 |
| `Settings` 目前只有 4 个字段，全部 `autoLockMinutes` 风格 | 新增浏览器字段必须 `#[serde(default)]`，否则老库读不进来 |

### 1.3 现有测试

| 位置 | 数量 |
| --- | --- |
| `keynest-core` 内联 `#[test]` | 121 |
| `keynest-core/tests/*`（集成） | 12 |
| `keynest-egui` 内联 | 20 |
| **合计** | **153** |

---

## 2. 可以直接复用的现有 API

### 2.1 密码库读写（`keynest_core::Vault`）

```rust
// 状态
pub fn new<P: AsRef<Path>>(path: P) -> Self
pub fn exists(&self) -> bool
pub fn is_unlocked(&self) -> bool
pub fn is_legacy(&self) -> bool
pub fn format(&self) -> Option<&'static str>

// 生命周期
pub fn unlock(&mut self, master: &str) -> Result<VaultData>
pub fn lock(&mut self)
pub fn snapshot(&self) -> Result<VaultData>      // 返回整库克隆（含所有明文密码）

// 条目
pub fn upsert_entry(&mut self, entry: Entry) -> Result<Entry>
pub fn delete_entry(&mut self, id: &str) -> Result<()>   // 软删除
pub fn restore_entry(&mut self, id: &str) -> Result<()>
pub fn purge_entry(&mut self, id: &str) -> Result<()>
pub fn import_entries(&mut self, incoming: Vec<Entry>) -> Result<ImportReport>
```

**浏览器桥只应使用其中四类能力**：`snapshot`（读）、`upsert_entry`（写）、`delete_entry`（软删）、`restore_entry`。不新增旁路。

### 2.2 条目模型（`Entry`）

```rust
pub struct Entry {
    pub id: String,              // uuid v4，空串表示"由 Vault 生成"
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub category: String,
    pub notes: String,
    pub favorite: bool,
    pub deleted_at: Option<String>,     // 软删除
    pub kind: String,                   // "账号" / "笔记" / ...（用户可自定义）
    pub fields: Vec<Field>,             // 自定义字段
    pub password_changed_at: Option<String>,
    pub totp: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

**观察**：`url` 是**自由字符串**，没有 origin 结构。浏览器匹配需要自己规范化，见 6.2。

### 2.3 CSV 导入（`keynest_core::portable`）

```rust
pub fn import_csv(text: &str) -> Result<(Vec<Entry>, usize)>
pub fn import_json(text: &str) -> Result<(Vec<Entry>, usize)>
pub fn detect_and_import(text: &str) -> Result<(Vec<Entry>, usize)>
pub fn export_csv(entries: &[Entry]) -> Result<Zeroizing<String>>
```

现成的能力：

| 需求 | 现状 |
| --- | --- |
| BOM 处理 | ✅ `trim_start_matches('\u{feff}')` |
| 引号/逗号/换行 | ✅ 用 `csv` crate（RFC 4180） |
| 多语言表头 | ✅ `col(&["name","title","标题","名称"])` 这类候选表匹配 |
| Chrome / Edge 列名 | ✅ 已匹配 `url`、`username`、`password`、`name`、`notes` |
| 返回值脱敏 | ✅ 导出返回 `Zeroizing<String>` |

**Chrome / Edge 的 CSV 已经能直接导入**（列名与 Bitwarden 子集一致）。阶段 4 要做的主要是**预览/合并/冲突处理**，不是解析器本身。

### 2.4 安全原语

```rust
keynest_core::secure::copy_sensitive_text(&str) -> Result<()>   // 仅 Win32
keynest_core::secure::system_idle() -> Duration
keynest_core::SecretKey                                          // VirtualLock + Zeroize
```

`windows` crate **0.58** 已在 `[target.'cfg(windows)'.dependencies]` 中引入，Named Pipe 可以直接用同一个 crate，**不需要新增大依赖**。

---

## 3. 需要新增的 Rust 模块

### 3.1 新 crate：`keynest-bridge`

不塞进 `keynest-core`：core 应保持"无 I/O 副作用、可跨平台测试"。桥接层有进程、管道、浏览器协议，属于另一层。

```
rust/keynest-bridge/
├── Cargo.toml
└── src/
    ├── lib.rs
    ├── protocol.rs     消息 schema、命令枚举、大小上限、版本协商
    ├── framing.rs      Native Messaging 4 字节长度前缀的编解码
    ├── native_host.rs  stdin/stdout 主循环（二进制入口）
    ├── pipe_client.rs  连 GUI 的 Named Pipe 客户端
    ├── auth.rs         会话挑战、握手状态机
    └── limits.rs       限流、超时、大小上限常量
```

**产物**：一个新的二进制 `keynest-native-host.exe`（~1 MB）。

### 3.2 GUI 侧新增模块

```
keynest-egui/src/
├── bridge/
│   ├── mod.rs
│   ├── server.rs        Named Pipe 服务端（后台线程）
│   ├── session.rs       会话/授权状态
│   └── handlers.rs      把请求映射到 Vault API + AppState 检查
└── views/settings.rs    增加 tab_browser()
```

### 3.3 依赖增量

| 依赖 | 用途 | 维护 | 许可 | 攻击面 | 能否用标准库替代 |
| --- | --- | --- | --- | --- | --- |
| `windows` 0.58（**已有**） | Named Pipe、安全描述符 | Microsoft | MIT/Apache | 已在用（剪贴板/内存锁） | 否 |
| `serde_json`（**已有**） | 消息编解码 | dtolnay | MIT/Apache | 已在用 | 否 |
| `zeroize`（**已有**） | 消息内密码擦除 | RustCrypto | MIT/Apache | 已在用 | 否 |
| `uuid`（**已有**） | 会话 id | uuid-rs | MIT/Apache | 已在用 | 可，但没必要 |

**结论：阶段 1 不需要任何新依赖。** 这是这套架构最实在的好处。

---

## 4. 浏览器扩展目录规划

```
browser-extension/
├── manifest.json           MV3，最小权限
├── background/
│   └── service-worker.js   唯一持有 nativePort 的地方
├── content/
│   ├── content-script.js   与 SW 通信的薄层
│   ├── form-detector.js    找登录表单
│   └── autofill.js         只负责"把值写进 input"
├── popup/
│   ├── popup.html/.js/.css 条目选择、锁定状态、连接状态
├── options/
│   ├── options.html/.js    站点授权管理、开关
├── lib/
│   ├── messaging.js        SW↔content 的消息封装
│   ├── origin.js           origin 规范化（与 Rust 侧同一套规则）
│   └── schema.js           消息字段白名单校验
├── icons/
└── tests/
    ├── unit/               node --test，纯函数测试
    └── e2e/                Chrome / Edge 加载解包测试清单
```

**不可协商的两条**：

1. `content-script` **永不**接触 `chrome.runtime.connectNative`——它只在 `background`。
2. `nativeMessaging` 权限只给 `background`。

---

## 5. Native Messaging 协议草案

### 5.1 传输层

Chrome/Edge 规定：

```
[4 字节小端长度][UTF-8 JSON 正文]
```

约束（我方再加严）：

| 项 | 上限 | 理由 |
| --- | --- | --- |
| 单条消息 | **1 MiB** | 浏览器官方上限；我们再小一点 |
| 响应长度 | 1 MiB | 同上 |
| 单次会话请求数 | 300 次 / 分钟 | 防刷 |
| 单请求处理超时 | 3 s | 防止 GUI 卡死拖住浏览器 |

### 5.2 消息信封

```jsonc
{
  "v": 1,                       // 协议版本，不匹配直接拒绝
  "id": "uuid",                 // 请求 id，响应必须回同一个
  "cmd": "vault.query",         // 白名单命令
  "session": "challenge-token", // 握手后获得
  "payload": { }
}
```

响应：

```jsonc
{
  "v": 1,
  "id": "uuid",
  "ok": true,
  "payload": { },
  "error": null
}
```

### 5.3 命令白名单（第一版只有 6 条）

| cmd | 方向 | 说明 | 锁定时 |
| --- | --- | --- | --- |
| `hello` | 扩展→Host | 握手，换取 session | 允许 |
| `status` | 扩展→Host | 返回 locked / unlocked / app-not-running | 允许 |
| `vault.query` | 扩展→Host | 按 origin 查询**匹配条目** | **拒绝** |
| `vault.fill` | 扩展→Host | 取某条目明文密码用于填充 | **拒绝** |
| `vault.save` | 扩展→Host | 用户确认后新建/更新条目 | **拒绝** |
| `vault.conflict` | 扩展→Host | 列出/裁决冲突 | **拒绝** |

**注意 `vault.query` 与 `vault.fill` 分开**：

- `query` 只返回 `{ id, title, username, url, matchKind }`，**不含密码**；
- `fill` 才拿密码，且必须带 `confirmToken`（用户在扩展 UI 点过"填充"后由 SW 生成的一次性令牌）。

这样即使网页脚本能诱导扩展发消息，也拿不到密码——因为它拿不到用户点击产生的 confirmToken。

### 5.4 明确拒绝的输入

- 未知 `cmd`
- `v` 不匹配
- 缺字段 / 多字段（多余字段直接拒，不做"宽容解析"）
- 字符串超长（title 256、username 320、password 4096、url 2048）
- 非 UTF-8
- 长度前缀与实际不符
- JSON 嵌套深度 > 8

---

## 6. Windows Named Pipe 安全设计

### 6.1 连接模型

```
keynest-native-host.exe  ──(client)──►  \\.\pipe\keynest-bridge-v1  ◄──(server) keynest-egui.exe
```

- **方向**：Host 主动连 GUI，GUI 只做服务端。这样浏览器启动 Host 时，若 GUI 没开，连接立刻失败，不会留一个等待中的孤儿管道。
- **命名**：固定名 `\\.\pipe\keynest-bridge-v1`，`v1` 是协议版本。**管道名不是身份凭证**，只用于找到入口。

### 6.2 访问控制（关键）

创建管道时必须显式设置安全描述符，而不是用默认值：

| 项 | 设置 |
| --- | --- |
| Owner | 当前用户 SID |
| DACL | **只授予当前用户 SID** `GENERIC_READ \| GENERIC_WRITE` |
| 拒绝 | `Everyone`、`ANONYMOUS`、`NETWORK`（`FILE_PIPE_REJECT_REMOTE_CLIENTS`） |
| 模式 | `PIPE_TYPE_MESSAGE \| PIPE_READMODE_MESSAGE`（消息边界由系统保证，不需要自己找分隔符） |
| 实例数 | **1**。只允许一个 Host 连接，多余的立刻 `ERROR_PIPE_BUSY` |

Windows 上"同一个用户"并不意味着"可信进程"——同一用户下的任何程序都能连。所以**必须有协议层认证**：

### 6.3 协议层认证（不依赖管道名）

```
1. GUI 启动时生成 32 字节随机 secret，仅存内存（SecretKey，VirtualLock）
2. Host 连接 → GUI 立即发 { challenge: 32B base64, nonce: 16B }
3. Host 用「shared secret」计算 HMAC-SHA256(challenge || nonce)，回送
4. GUI 用 subtle::ConstantTimeEq 比对
5. 通过后发 session token（16B，有效期 = 连接生命周期）
```

**shared secret 从哪来？** 这是本设计唯一需要新机制的地方。三个候选：

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 安装时生成密钥文件** | 安装程序生成 32B 随机 secret，写到 `%LOCALAPPDATA%\KeyNest\bridge.key`，DACL 只给当前用户 + `SYSTEM` | 简单、可重启后继续用 | 同用户恶意进程能读这个文件 → 只能防"其他用户"，防不了"同用户恶意程序" |
| **B. 每次启动由 GUI 重新生成** | GUI 启动时写 secret 到文件，退出时删除 | 有效期短 | 浏览器在 GUI 未启动时连不上（可接受，因为本来就锁着） |
| **C. 依赖管道 ACL + 进程签名校验** | 校验对端进程的可执行文件签名 | 最强 | 需要代码签名证书，项目现在没有 |

**推荐 B + A 的混合**：安装时生成长期 secret（A）用于 Host↔GUI 身份确认，同时 GUI 每次启动轮换一个短期 secret（B），短期 secret 覆盖长期 secret。这样"文件被盗"只在同一用户会话内有效，且仍需 GUI 正在运行。

> **必须诚实承认的边界**：同一 Windows 用户下的恶意进程，理论上可以读秘密文件、可以连管道。任何不带代码签名的纯本地方案都挡不住它。这一点会写进 SECURITY.md，不夸大。

### 6.4 其他约束

| 要求 | 实现 |
| --- | --- |
| 禁止远程 | `FILE_PIPE_REJECT_REMOTE_CLIENTS` |
| 禁止 0.0.0.0 / TCP | 全程无 socket，只有 named pipe |
| 断开处理 | 读返回 0 字节或 `ERROR_BROKEN_PIPE` → 立即清理 session、擦除内存 |
| 超时 | 单次读 3 s 超时；超时视为恶意，直接断开 |
| GUI 锁定 | `AppState::Locked` 时，除 `status` 外的命令一律回 `locked` |
| 崩溃 | Host 检测到 GUI 进程消失 → 关闭自己（浏览器会显示扩展断连） |

---

## 7. Chrome / Edge 安装注册方案

### 7.1 Native Messaging Host 清单

注册表位置（HKCU，**不需要管理员权限**，与绿色版定位一致）：

```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge
HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge
```

值 = 清单 JSON 的绝对路径。

清单内容：

```jsonc
{
  "name": "com.keynest.bridge",
  "description": "KeyNest Browser Bridge",
  "path": "C:\\path\\to\\keynest-native-host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<扩展ID>/"]
}
```

### 7.2 扩展 ID 的处理（**这条最容易踩坑**）

- Chrome 用 `key` 字段固定扩展 ID；不设 `key` 时 ID 由路径哈希决定，**每台机器不同**。
- Edge 同源 Chromium，规则一致。
- **开发 ID ≠ 发布 ID。**

因此：

| 环境 | 做法 |
| --- | --- |
| 开发 | `manifest.json` 里带固定 `key`（自己生成 RSA 公钥 base64），ID 稳定可预测；`allowed_origins` 写这个开发 ID |
| 发布 | 商店 ID 由商店分配，`allowed_origins` 必须改成商店 ID —— **不能猜** |
| 安装器 | 安装时读配置里的 ID 列表写清单，**支持多个 ID**（Chrome 商店 + Edge 商店 + 开发） |

**安装器不得在代码里硬编码一个"看起来对"的 ID。** 未登记的 ID 连不上，这是正确行为。

### 7.3 安装 / 卸载

```
安装：
  1. 复制 keynest-native-host.exe 到 %LOCALAPPDATA%\KeyNest\bin\
  2. 写 com.keynest.bridge.json
  3. 写 HKCU 两条注册表项（Chrome / Edge）
  4. 自检：启动 host 跑 hello 协议，失败则回滚全部改动

卸载：
  只删：
    - 自己写的那两条注册表项
    - %LOCALAPPDATA%\KeyNest\bin\keynest-native-host.exe
    - 自己的清单 json
  绝不删：
    - vault.dat 及其备份（**用户数据**）
    - 其他软件的 NativeMessagingHosts 项
```

---

## 8. 各阶段开发任务

| 阶段 | 内容 | 预计改动 | 风险 |
| --- | --- | --- | --- |
| **0（本次）** | 架构审计 | 仅本文档 | — |
| **1** | `keynest-bridge` crate + Named Pipe 服务端 + 握手 + 单元测试 | +2,500 行 / 3 文件改动 | 中：管道 ACL 写错会开权限口子 |
| **2** | 扩展 MV3 + SW + content script + 手动填充 | 新增 `browser-extension/` ~1,800 行 | 中：表单识别在 SPA 上不稳 |
| **3** | 自动保存（登录后提示） | +600 行 | 高：误判登录成功会存错密码 |
| **4** | Chrome/Edge CSV 兼容导入 + 预览合并 | +400 行（复用现有 parser） | 低 |
| **5** | 同步/冲突/删除保护 | +800 行 | 高：冲突裁决逻辑容易出错 |
| **6** | 真实浏览器 + 安全测试报告 | 文档 + 测试清单 | — |

每阶段独立分支（`feat/browser-bridge` 等），不直接推 main。

---

## 9. 安全风险清单

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | 同用户恶意进程读 secret 文件 | **高（无法根治）** | 短期 secret 轮换 + 文档如实声明 |
| 2 | 网页伪造 extension 消息 | 高 | content script 不可信；SW 校验 `sender.id` + `sender.tab.url`；填充需 confirmToken |
| 3 | 跨站填充（evil.com 拿 example.com 的密码） | **高** | 精确 origin 匹配；不做子串匹配；HTTPS 才自动匹配 |
| 4 | 恶意 iframe 偷填充值 | 高 | 跨域 iframe 一律拒绝填充 |
| 5 | 日志泄露密码 | 中 | 全链路用 `Zeroizing<String>`；Debug 手写脱敏；日志只记 cmd 名与错误码 |
| 6 | 扩展 storage 残留密码 | 中 | 密码永不进 `chrome.storage`；只存 session token |
| 7 | 重放旧请求 | 中 | 每请求 `id` 去重 + 单调 session 序号 |
| 8 | 消息洪水 | 低 | 300 req/min 限流 + 1 MiB 上限 |
| 9 | 哈希比对泄露密码 | 中 | **禁止**用 SHA-256 比对密码；比较在 GUI 进程内用常量时间比较 |
| 10 | 已删除条目被旧客户端"复活" | 中 | 软删除 + tombstone；`restore` 必须显式 |
| 11 | 时钟回拨导致错误"较新"判断 | 中 | 用单调版本号而非时间戳裁决 |
| 12 | Native Host 被当成后门（免解锁读库） | **高** | Host **不打开 vault.dat**，只转发给 GUI；GUI 锁定即拒绝 |

**第 12 条是这套设计的核心不变量**，任何实现细节都不得破坏它。

---

## 10. 决策记录（2026-11-02 业主确认）

| # | 问题 | **决策** | 落地约束 |
| --- | --- | --- | --- |
| 1 | `Entry.rev` | **有条件批准** | 见第 13 节：先验证旧程序是否会丢字段，结论是**会丢**，因此单独成节讨论，未擅自动手 |
| 2 | 页面加载自动填充 | **禁止** | 只能用户点图标或选条目；点击必须由扩展特权上下文验证 |
| 3 | HTTP 站点 | **默认禁止** | 逐站授权 + 明显风险提示；HTTPS 精确 origin，禁止子串/子域通配 |
| 4 | Host↔GUI 加密 | **要做** | challenge → HMAC-SHA256 → HKDF → AEAD；阶段 1 已实现 |
| 5 | 商店上架 | **暂不** | 先开发者模式；架构预留 4 个 ID 槽位；不得硬编码猜测的正式 ID |
| 6 | CSV 冲突 | **默认跳过** | 预览分五类展示；可保留两份或明确选择更新；未经确认不覆盖 |
| 7 | 版本号 | **v0.5.0** | 独立分支开发；不动 v0.4.3 Tag / Release |

## 11. 兼容性风险（不改格式的前提下）

| 改动 | 兼容性 | 验证方法 |
| --- | --- | --- |
| `Entry` 加 `rev` | 旧库读入 → 0；旧程序读新库 → 忽略该字段 | 用 v1/v2/v3 三个真实样本各跑一遍 |
| `Settings` 加浏览器字段 | 必须 `#[serde(default)]`，否则老库 `Deserialize` 失败 | 现有 `legacy_fast_path_still_works` 测试会覆盖 |
| `VaultData.version` | **不改**。新增字段不改变格式版本号 | — |

**不做的事**：不改 AEAD 的 AAD，不改 KDF 参数，不改 `payload` 的结构层级。密文格式一行不动。

---

## 12. 阶段 0 的产出与边界

- 本文档 = 阶段 0 的唯一产物。
- **没有**新增 Rust 代码、没有改 `main`、没有动 Tag / Release / 历史。
- 本文档目前**未提交**，等你确认后我再决定放哪个分支。

**等你的答复（尤其是第 10 节的 7 条），然后进入阶段 1。**

---

## 13. `Entry.rev` 的前向兼容性实验（决策 1 的答复）

### 13.1 实验设计与结果

问题：**v0.4.3 读入含 `rev` 的库、修改后保存，`rev` 还在吗？**

实验（`rust/keynest-core/tests/forward_compat.rs`，已落地并运行）：

```rust
let e: Entry = serde_json::from_str(json_with_rev).unwrap();
let back = serde_json::to_string(&e).unwrap();
assert!(!back.contains("\"rev\""));   // 通过
```

**结果：`rev` 会被静默丢弃。** 库顶层的未知字段同理。

原因：`Entry` 与 `VaultData` 都是固定结构体，没有 `deny_unknown_fields`，
也没有 `#[serde(flatten)]` 兜底。反序列化阶段未知字段就被扔掉，
再保存时自然不在了。

### 13.2 这意味着什么

| 场景 | 后果 |
| --- | --- |
| 新程序写 `rev=7` → 旧程序打开并**只读** | 正常，`rev` 不显示，不影响密码 |
| 新程序写 `rev=7` → 旧程序**改任何字段并保存** | `rev` 变回「不存在」，等于 0 |
| 之后新程序再读 | 所有条目 `rev=0`，冲突裁决失去依据 |

**结论：不能宣称"完全向后兼容"。** 这不是数据损坏（密码不会丢），
但会让「按版本号裁决冲突」这个机制在某些用户那里静默失效。

### 13.3 三个可选方案（**未选择，等你决定**）

| 方案 | 做法 | 优点 | 缺点 | 破坏性 |
| --- | --- | --- | --- | --- |
| **A. 独立同步元数据文件** | 新增 `%LOCALAPPDATA%\KeyNest\sync.db`（或 `vault.dat.sync`），存 `entry_id → rev, last_source`。密码库本身零改动 | 旧程序完全无感；不会丢 | 多一个文件要跟着备份/迁移；恢复备份后元数据可能与库不同步 | **无** |
| **B. 格式版本升到 v4** | `format: "keynest.v4"`，`Entry.rev` 进正文 | 语义最干净 | **旧程序拒绝打开**（`UnsupportedFormat`）；用户无法降级 | **高** |
| **C. 保持 v3，接受 rev 可能丢失** | `rev` 照常进 `Entry`，靠 `updated_at` 兜底 | 实现最省事 | 旧程序改过的条目 rev 归零，冲突裁决退化为时间戳 | 低，但机制不可靠 |

### 13.4 我的建议（仅建议）

**方案 A。** 理由：

1. 密码库密文格式**一行都不用改**，`v1/v2/v3` 全部照旧可读；
2. 旧程序不会丢东西，因为东西不在库里；
3. 元数据文件丢失时最坏退化为"全部 rev=0"，等价于方案 C 的现状，不会更糟；
4. 与「不改变现有密码学体系」这条硬约束天然一致。

代价：需要定义清楚「库与元数据不一致」时的处理（我的倾向是以库为准、
把对不上的条目视为 rev=0）。

**在你确认方案之前，阶段 1 不引入 `rev`。** 阶段 1 只做传输层，本来也不需要它。

### 13.5 明确区分四个问题

| 问题 | 答案 |
| --- | --- |
| 外层加密格式是否变化？ | **不变化**（仍是 `keynest.v3`，同样的 AAD、同样的 KDF 参数） |
| 加密后的明文序列化结构是否变化？ | **阶段 1 没有任何变化**；未来加 `rev` 才会变 |
| 是否需要格式版本升级？ | 方案 A/C **不需要**；方案 B 需要 |
| 旧版本能否读取、修改、保存？ | 能读、能改、能存；但**会丢掉它不认识的字段** |
