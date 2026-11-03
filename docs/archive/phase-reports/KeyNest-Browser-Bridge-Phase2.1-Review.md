# KeyNest 浏览器集成 · 阶段 2.1 审查报告

> 分支 `feat/browser-bridge` · HEAD `f20475b` · 工作区干净 · main `09b870d` 未动 · v0.4.3 Tag `2bd390e` 未动
> 日期：2026-11-02
> 性质：**只读审查。未执行注册脚本、未写注册表、未加载扩展、未访问真实密码库。**

---

## 0. 结论摘要

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| **FAIL（真实缺陷，建议修）** | **3** | 跨站 origin 判定、`sender.tab` 判定不可靠、填充令牌形同虚设 |
| PASS | 18 | 见各节 |
| NOT TESTED | 9 | 真实浏览器/管道相关 |
| BLOCKED | 4 | 需第二账户或第二台机器 |

**其中 1 项属于安全缺陷**（content script 的 `startsWith` 判定），修法很小但影响真实。

---

## 1. 注册脚本审查

### 1.1 脚本内容（关键片段）

```powershell
$DataDir  = Join-Path $env:LOCALAPPDATA 'KeyNest'
$Manifest = Join-Path $DataDir 'com.keynest.bridge.json'

$manifestObj = [ordered]@{
    name            = 'com.keynest.bridge'
    description     = 'KeyNest Browser Bridge'
    path            = $HostExe
    type            = 'stdio'
    allowed_origins = $origins     # 只含显式传入的 ID
}
```

注册表（HKCU，两条）：

```
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge
（默认值）= <manifest 绝对路径>
```

卸载分支：只 `Remove-Item` 上述两个键 + 删除 `com.keynest.bridge.json`。

### 1.2 逐项检查

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 是否覆盖其他程序注册项 | **PASS** | 只操作 `com.keynest.bridge` 这一个子键；不枚举、不清空 `NativeMessagingHosts` 父键 |
| 2 | 只写 HKCU，不需要管理员 | **PASS** | 全部 `HKCU:\` 路径；脚本无 `#Requires -RunAsAdministrator` |
| 3 | manifest 路径正确 | **PASS** | `%LOCALAPPDATA%\KeyNest\com.keynest.bridge.json`，与 `bridge.key` 同目录 |
| 4 | 扩展 ID 使用正确 | **PASS** | 只接受参数传入；格式校验 `^[a-p]{32}$` |
| 5 | 是否把开发 ID 当正式 ID | **PASS** | 脚本**不接受**硬编码；无 ID 直接报错并退出 |
| 6 | 卸载只删自己的项 | **PASS** | 见 1.1；守卫测试验证幂等 |
| 7 | 失败回滚 | **PASS** | `try/catch` 内 `Remove-OurRegistry` + 删 manifest 后 rethrow |
| 8 | 是否碰 vault.dat / bridge.key | **PASS** | 脚本无任何 `vault` / `bridge.key` 引用；只写 manifest 与注册表 |

### 1.3 实际验证（只读，未写注册表）

| 验证 | 结果 |
| --- | --- |
| PS 5.1 语法解析 | **PASS**（补 UTF-8 BOM 后；无 BOM 时中文注释导致 4 处解析错误——这是阶段 2 已修的缺陷） |
| 无 ID 调用被拒且无副作用 | **PASS** |
| 非法 ID 被拒且无副作用 | **PASS** |
| HostExe 不存在被拒且无副作用 | **PASS** |
| `-Uninstall` 幂等（未注册时） | **PASS** |
| 当前机器注册状态 | **未注册**（两条键与 manifest 均不存在） |
| 真实注册 | **BLOCKED**（本阶段禁止执行） |

**注册表前后差异（本阶段）**：无差异。我没有执行任何写入。

---

## 2. 扩展消息授权审查

### 2.1 当前实现

```js
const fromPopup   = !sender.tab && sender.id === chrome.runtime.id;
const fromContent = !!sender.tab;
```

`fill` / `query` 要求 `fromPopup`，否则 `PRIVILEGED_ONLY`。

### 2.2 逐项检查

| # | 检查项 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | `sender.id` 校验 | **PASS** | 与 `chrome.runtime.id` 比对；外部消息未开放（无 `externally_connectable`） |
| 2 | `sender.tab` 判定 | **FAIL** | 见缺陷 B |
| 3 | `sender.frameId` | **NOT USED** | 未读取；填充固定 `frameId: 0` |
| 4 | `sender.url` | **NOT USED** | 未校验发送方 URL |
| 5 | 扩展特权页面身份 | **FAIL** | 仅靠 `!sender.tab` 推断，`options_ui` 的 `open_in_tab: true` 破坏该假设 |
| 6 | 当前 tab 的真实 URL | **PASS** | `chrome.tabs.get(tabId)` 取浏览器侧 URL，不信任消息里的地址 |
| 7 | frame 与 origin | **部分** | 只填 `frameId: 0`；content script `all_frames: false` |
| 8 | 页面导航后授权失效 | **部分 PASS** | 每次 fill 都重新 `tabs.get` → 导航后 origin 变了自然拒绝；但 token 未绑定导航 |
| 9 | 旧令牌重放 | **FAIL** | 见缺陷 C |
| 10 | content script 伪造请求 | **PASS（设计）** | `fill`/`query` 对 `sender.tab` 存在者返回 `PRIVILEGED_ONLY` |
| 11 | 网页 `postMessage` 诱导 | **PASS** | content script 无 `window.addEventListener('message')`；不转发网页消息 |

### 缺陷 A（安全，需修）：content script 用 `startsWith` 判 origin

```js
const here = `${location.protocol}//${location.host}`.toLowerCase();
if (!here.startsWith(msg.origin)) { /* 拒绝 */ }
```

`https://example.com.evil.test`.startsWith(`https://example.com`) === **true**。

后果：若攻击者能让 content script 收到一条 `origin: "https://example.com"` 的 `do-fill`，
在 `example.com.evil.test` 页面上会被**接受**并填入密码。

现实可达性：content script 只接受扩展内部消息（`chrome.runtime.onMessage`），
网页无法直接投递。所以这是**纵深防御失效**，不是可直接利用漏洞——
但它违反了阶段规范「不允许字符串包含匹配」，且一旦将来引入任何转发路径就变成真漏洞。

**修法**（1 行）：改为**精确相等**比较，用与 Rust 同规则的规范化函数。

### 缺陷 B（功能 + 授权，需修）：`sender.tab` 不能作为可信判据

manifest 里：

```json
"options_ui": { "page": "popup/popup.html", "open_in_tab": true }
```

选项页在标签页里打开时，`sender.tab` **存在** → 被判定为 content script →
`query`/`fill` 全部返回 `PRIVILEGED_ONLY`，**用户在选项页里点不了填充**（功能坏）。

更值得注意的是判据本身：`sender.tab` 只能区分"有没有标签页上下文"，
不能证明"这是扩展自己的特权页面"。任何在标签页中运行的扩展页面（含未来新增的）
都会被误分类。

**修法**：改用 `sender.url` 精确比对扩展自己的页面 URL：

```js
const EXT_BASE = chrome.runtime.getURL('');           // chrome-extension://<id>/
const fromExtensionPage =
  sender.id === chrome.runtime.id &&
  typeof sender.url === 'string' &&
  sender.url.startsWith(EXT_BASE);                    // 前缀在此是安全的：EXT_BASE 是固定前缀
const fromContent = !!sender.tab && !fromExtensionPage;
```

### 缺陷 C（需修）：填充令牌形同虚设

SW 生成 `nonce` 并存入 `tokens` Map，但：

1. 发给 content script 后，content script **完全不校验** `nonce`；
2. token 在 `finally` 里立即 `delete`，从未被验证过；
3. 没有绑定导航（`chrome.webNavigation` 未使用）。

也就是说，token 目前只是一个"写了但没用"的字段。阶段规范要求它绑定
tab/frame/origin/entry 并被二次校验——**这条没做到**。

**修法**：content script 收到 `do-fill` 后回 `nonce` 确认；SW 校验
`tokens.get(nonce)` 的 `tabId/frameId/origin` 与当前一致且未用过，然后才发密码。
或者干脆去掉 token（承认它没用），但这与规范冲突，不建议。

---

## 3. 完整密码传输路径

```
① Vault（core，Rust）
   e.password : String  ← 密码库解密后就在内存里，生命周期 = 解锁期间
        │
        │ clone()
        ▼
② GUI（app.rs bridge_fill）
   Zeroizing::new(e.password.clone())   ← 有保护
        │
        │ mpsc 通道（进程内）
        ▼
③ VaultProxy → server.rs dispatch
   password : Zeroizing<String>          ← 有保护
        │
        │ serde_json::json!({"password": &*password})
        ▼
④ JSON 序列化 → String（**明文，无保护**）
        │
        │ SessionCipher::seal → XChaCha20-Poly1305
        ▼
⑤ 密文帧 → 命名管道（**加密传输**）
        │
        ▼
⑥ Native Host：read_frame → Vec<u8> → write_frame
   （**原样转发，不解析、不解密**；缓冲区 Vec<u8> 离开作用域不擦除）
        │
        │ stdout（仍为密文？否——见下）
        ▼
⑦ Service Worker：解密发生在 GUI 侧，Host 只是转发密文；
   但 SW 收到的是**明文 JSON**（因为 GUI 加密的是"Host↔GUI"这一段，
   Host 到浏览器的 Native Messaging 段是明文 JSON）
        │
        ▼
⑧ SW：password 局部变量（JS 字符串，**无法擦除**）
        │
        ▼
⑨ chrome.tabs.sendMessage → content script（明文 IPC）
        │
        ▼
⑩ content script：msg.password → input.value（**进入 DOM**）
```

### 逐段回答

| 段 | 明文？ | 临时缓冲 | 字符串副本 | 可进日志？ | 可入扩展存储？ |
| --- | --- | --- | --- | --- | --- |
| ① Vault | 是（解锁期间常驻） | — | — | 否（Debug 脱敏） | 否 |
| ② GUI | 是 | `Zeroizing<String>` | 1 次 clone | 否 | 否 |
| ③ Proxy/通道 | 是 | `Zeroizing<String>` | 1 次 | 否 | 否 |
| ④ JSON | **是** | `String`（**未擦除**） | 1 次 | 否（无 println） | 否 |
| ⑤ 管道 | **否（加密）** | 密文 `Vec<u8>` | — | 否 | 否 |
| ⑥ Host | 否（转发密文） | `Vec<u8>` ×2 | — | 否（只写 stderr 错误码） | 否 |
| ⑦ SW 收到 | **是** | JS 对象 | — | 否（无 console.log） | 否 |
| ⑧ SW 传递 | **是** | JS 字符串 | — | 否 | **否**（无 storage 调用） |
| ⑨ IPC | **是** | Chrome 内部 | — | 否 | 否 |
| ⑩ 输入框 | **是（进入 DOM）** | — | — | 否 | 否（页面可读，见风险） |

### 清理时机

| 事件 | 清理行为 |
| --- | --- |
| 填充完成 | content script `msg.password = null`；popup `window.close()` |
| 超时 | SW 5 s 超时 reject；`inflight` 删除；Host 侧看门狗断开连接 |
| 断连 | `onDisconnect` 清空所有 inflight |
| 关闭 Popup | popup 销毁；SW 中的局部变量随消息处理结束释放 |
| GUI 锁定 | `BridgeService::stop()` + 门禁拒绝；已建立的会话在下一次请求被拒 |

### `Zeroizing<String>` 的保护范围（必须如实）

**覆盖**：②③ 两处的 Rust 堆内存，离开作用域即 `zeroize`。

**不覆盖**：
- ④ JSON 序列化产生的 `String`（明文，未包 `Zeroizing`）——**这是一个已知缺口**
- ⑥ Host 的 `Vec<u8>` 缓冲区（虽为密文，但未擦除）
- ⑦⑧⑨ 所有 JavaScript 字符串——**JS 引擎不提供擦除 API**，GC 前可能残留任意长时间
- ⑩ 页面输入框里的值（页面脚本可读）
- 操作系统的换页、崩溃转储、剪贴板（未使用剪贴板）

**不得声称 `Zeroizing` 能擦除 JS 字符串或所有 IPC 副本。** 它只覆盖 Rust 侧两处。

---

## 4. 锁定状态测试分类

| 层级 | 是什么 | 当前状态 |
| --- | --- | --- |
| **① 单元测试** | `handle_one` 直接喂 JSON，`FakeOps.locked()` 返回 Locked | **PASS**（`locked_vault_refuses_requests_via_handle_one`） |
| **② 模拟 GUI 门禁** | `serve_with_challenge` 走完整握手+加密，ops 是内存假实现 | **PASS**（`end_to_end_locked_session_refuses_passwords`） |
| **③ 真实 GUI** | 真 `Vault` + 真解锁 + 真锁定 | **NOT TESTED** |
| **④ 真实 Named Pipe** | 真管道句柄 + 真进程 | **BLOCKED**（需解锁主密码） |

### 「锁定时桥接不启动」与「`VAULT_LOCKED` 测试」是否矛盾？

**不矛盾，它们是两层不同的防线。**

- **第一层（生命周期）**：`BridgeService` 只在 `AppState::Unlocked` 时 `start()`，
  锁定时 `stop()`。所以正常情况下，锁定时**根本没有服务线程在监听管道**。
  冒烟已验证：锁定时启动 GUI → 无 `bridge.key` 生成 → 服务未起。

- **第二层（门禁）**：如果服务线程因为竞态/延迟仍然存在（例如刚锁定的瞬间，
  线程还在上一轮 `serve` 里没退出），`handle_one` 的锁定门禁仍会拒绝敏感命令。

第二层是**为第一层失效时兜底**存在的。所以测试第二层不等于测试第一层，
反之亦然。只有 ③④ 才能证明"真实链路"，目前两者都缺。

---

## 5. 人工冒烟测试步骤

> 全程使用**虚构账号与测试密码**。不得使用真实登录账号。

### 准备

1. 确认 Chrome 版本 ≥ 102（`chrome://version`）
2. 确认 `browser-extension/manifest.json` 的 `manifest_version: 3`
3. 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展」
   选择 `browser-extension/` 目录 → **记录生成的扩展 ID**（32 位 a-p）
4. 人工审查 `scripts/register-native-host-dev.ps1`（本报告第 1 节）
5. 由你手动执行：
   ```powershell
   .\scripts\register-native-host-dev.ps1 `
     -HostExe "G:\Scripts\keynest\rust\target\debug\keynest-native-host.exe" `
     -ChromeId "<第 3 步记录的 ID>"
   ```
   （Edge 同理加 `-EdgeId`）

### 测试矩阵

| # | 场景 | 预期 | 记录 |
| --- | --- | --- | --- |
| 1 | GUI 未启动，点扩展图标 | 显示「未连接」，不返回任何条目 | |
| 2 | GUI 启动但锁定 | 显示「已锁定」，无条目 | |
| 3 | 解锁后点图标 | 列出该 origin 的条目，**不含密码** | |
| 4 | 点条目填充（HTTPS 测试页） | 账号密码填入，popup 关闭 | |
| 5 | HTTP 页面 | 拒绝，提示非 HTTPS | |
| 6 | 错误 origin（用 `example.com.evil.test` 类页面） | 拒绝填充 | |
| 7 | 填充后导航到别的站，再点图标 | 重新查询，旧结果不复用 | |
| 8 | 页面内 iframe 登录框 | 不填充（`all_frames: false`） | |
| 9 | 网页尝试 `postMessage` 诱导 | 无反应 | |
| 10 | 填充过程中锁定 GUI，再点填充 | 拒绝，`VAULT_LOCKED` | |
| 11 | 检查 `chrome://extensions` 的 SW 控制台 | **无密码输出** | |
| 12 | 检查 `chrome.storage.local` / `sessionStorage` | **无密码** | |
| 13 | 检查剪贴板 | **未使用剪贴板** | |
| 14 | 卸载：`-Uninstall` | 两条注册表项与 manifest 消失；`vault.dat` 不受影响 | |

**测试页建议**：本地起一个静态页（`file://` 不行，需 `https://`）。
可用 `https://example.com` 的登录框？它没有表单。
建议用任意公开测试站的登录页，或自建带自签证书的本地 HTTPS 服务。

---

## 6. 尚存风险

| # | 风险 | 等级 | 说明 |
| --- | --- | --- | --- |
| 1 | **content script `startsWith` 判定** | **中（纵深防御失效）** | 见缺陷 A；现实不可直接利用，但违反规范 |
| 2 | **`sender.tab` 判据不可靠** | 中（功能 + 授权） | 见缺陷 B；选项页功能坏，判据本身不严谨 |
| 3 | 填充令牌未被校验 | 中 | 见缺陷 C；规范要求绑定并二次校验 |
| 4 | JSON 序列化的明文 `String` 未擦除 | 低 | Rust 侧唯一未覆盖的明文副本 |
| 5 | JS 字符串无法擦除 | **无法消除** | MV3 固有限制；密码必然经过 SW 与 content script |
| 6 | 密码进入页面 DOM | **无法消除** | 填充的语义就是"写进输入框"；页面脚本可读 |
| 7 | 同用户恶意进程可读 `bridge.key` | **无法消除** | 已如实文档化 |
| 8 | 从未真实浏览器验证 | **高** | 所有 PASS 都是单元/代码审查级别 |

---

## 7. Git 状态

```
分支        feat/browser-bridge
HEAD        f20475b  feat(bridge): wire GUI server and add MV3 extension (phase 2)
main        09b870d  （未动）
v0.4.3 Tag  2bd390e  （未动）
工作区      干净
本阶段改动   仅新增本报告文件
```

未推送、未合并、未改历史。

---

## 8. 需要你决定

| # | 事项 | 选项 |
| --- | --- | --- |
| 1 | 缺陷 A（`startsWith`）要不要现在修？ | 建议**修**（1 行，安全相关） |
| 2 | 缺陷 B（`sender.tab`）要不要现在修？ | 建议**修**（选项页功能是坏的） |
| 3 | 缺陷 C（令牌）要不要现在修？ | 建议**修**，或明确降级为"暂不使用令牌"并改文档 |
| 4 | 注册脚本由你手动执行，还是授权我执行？ | 建议你手动（写注册表） |

**本阶段未修改任何代码，等你的决定。**
