# KeyNest 浏览器集成 · 阶段 2.3 报告（并发与 Frame 绑定复核）

> 分支 `feat/browser-bridge` · 基线 `c1d3faf` · main `09b870d` 未动 · v0.4.3 Tag `2bd390e` 未动
> 日期：2026-11-02
> **未写注册表、未安装扩展、未访问真实密码库。**

---

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 并发兑换能否成功两次 | **不能**，但**修复前存在"全部失败"的相反缺陷**（见 3.2） |
| iframe origin 是否正确验证 | **修复前只校验顶层 URL**（真实缺口）；现在校验 `webNavigation.getFrame()` 的实际 frame URL |

**两处都改了代码，不是"已通过"式复核。**

---

## 1. `redeem-fill` 完整调用链

```text
content script
  └─ chrome.runtime.sendMessage({type:'redeem-fill', nonce, entryId})
       │
       ▼
service-worker: onMessage
  ├─ classifySender(sender)              ← 同步，纯函数（lib/sender.js）
  ├─ kind !== 'content' → 拒绝
  └─ handleRedeem(msg, sender)           ← async
       ├─ nonce 空 → NO_NONCE
       ├─ frameId = sender.frameId ?? 0
       ├─ senderOrigin = normalize(sender.url)     ← 同步
       └─ redeemFillWithChrome(nonce, claimed)
            │
            ▼
       lib/redeem.js :: redeemFill(auths, deps, nonce, claimed)
            │
            ├─【同步】auths.claim(nonce, claimed)  ◄── 并发分水岭
            │     └─ 失败 → 立即返回 AUTH_REJECTED（不 await、不调浏览器 API）
            │
            ├─【await 1】deps.getFrame({tabId, frameId})    ← webNavigation.getFrame
            │     ├─ 抛错 → invalidate → FRAME_GONE
            │     ├─ 无 url → invalidate → FRAME_GONE
            │     └─ normalize(frameInfo.url) !== rec.origin → invalidate → FRAME_ORIGIN_MISMATCH
            │
            ├─【await 2】deps.getTab(tabId)                 ← chrome.tabs.get
            │     ├─ 抛错 → invalidate → TAB_GONE
            │     ├─ 无 url → invalidate → TAB_GONE
            │     └─ normalize(tab.url) !== rec.origin → invalidate → TOP_ORIGIN_MISMATCH
            │
            ├─【同步】auths.confirm(nonce)  ◄── validating → consuming
            │     └─ 失败（已被 abort）→ AUTH_ABORTED
            │
            ├─【await 3】deps.fill({entry_id, origin, confirm:nonce})  ← 唯一取密码处
            │     └─ 抛错 → invalidate → FILL_FAILED
            │
            ├─ password 非字符串/空 → invalidate → NO_PASSWORD
            └─【同步】auths.consume(nonce) → 返回 {ok, username, password}
```

## 2. 所有异步等待位置

| # | 位置 | 在 `claim` 之前？ | 说明 |
| --- | --- | --- | --- |
| 1 | `deps.getFrame()` | ❌ 之后 | 只有认领成功的请求才会走到这里 |
| 2 | `deps.getTab()` | ❌ 之后 | 同上 |
| 3 | `deps.fill()` | ❌ 之后 | 唯一取密码处，且已 confirm |

**`claim()` 是整条链上唯一的同步关卡，且位于所有 await 之前。**
`classifySender`、`normalize`、`confirm`、`consume` 也全是同步。

---

## 3. 并发安全结论

### 3.1 现在为什么安全

JavaScript 单线程 + `claim()` 同步：

```js
const rec = auths.claim(nonce, claimed);   // 100 个并发里只有 1 个得到非 null
if (!rec) return { ok:false, error:'AUTH_REJECTED' };
const frame = await deps.getFrame(...);    // 此时才第一次 await
```

事件循环保证 `claim` 与下一个消息处理之间不会被插入，所以不存在
"两个请求都读到 issued" 的窗口。

**没有 per-token mutex，也不需要**——同步状态转换本身就是独占。

### 3.2 复核中发现并修复的**相反缺陷**（重要）

修复前的 `claim` 在"状态不是 issued"时**删除记录**：

```js
if (r.state !== 'issued') {
  this.records.delete(nonce);   // ← 错
  return null;
}
```

后果：100 个并发请求里，第 2 个到达时记录已处于 `validating`，
于是它**删掉了记录** → 第 1 个请求的 `confirm()` 找不到记录 → **100 个全部失败**。

这不是安全问题（没有泄露），但会让填充功能在真实浏览器里**偶发完全失灵**。
100 并发测试直接暴露了它：`ok.length === 0`。

**修复**：状态不是 `issued` 时**只返回 null，不删记录**。
理由写在代码注释里：记录已归第一个请求所有，后续请求拿不到任何东西；
删掉反而会毁掉合法请求。同时补了一条"已认领后乱试也不销毁（防 DoS）"的测试。

**只有 `issued` 状态下的绑定值不符才销毁**（那是明确的攻击信号）。

### 3.3 100 请求并发测试结果

| 测试 | 结果 | 证据 |
| --- | --- | --- |
| 100 并发（无延迟） | **PASS** | 成功 1 / 拒绝 99；`fill`=1、`getFrame`=1、`getTab`=1 |
| 100 并发 + 50ms 延迟 | **PASS** | 成功 1；`fill`=1 |
| 100 并发 + fill 50ms 延迟 | **PASS** | 成功 1；`fill`=1 |
| 并发中 `tabs.get` 失败 | **PASS** | 全部拒绝；`fill`=0；记录销毁 |
| 并发中 `getFrame` 失败 | **PASS** | 全部拒绝；`fill`=0 |
| fill 抛错（中途断连） | **PASS** | 记录销毁；**再试也失败** |
| 认领后被外部清空 | **PASS** | 拒绝；`fill`=0 |

关键断言：`calls.getFrame === 1` 证明**认领确实在所有 await 之前**——
如果认领在 await 之后，100 个请求会各调一次 `getFrame`。

---

## 4. 实际 frame origin 获取方式

### 4.1 字段来源与可信度

| 字段 | 来源 | 可信？ |
| --- | --- | --- |
| `tab.url` | `chrome.tabs.get()` | **浏览器可信** |
| `frameInfo.url` | `chrome.webNavigation.getFrame({tabId, frameId})` | **浏览器可信** |
| `sender.url` | Chrome 注入的 MessageSender | **浏览器可信** |
| `sender.frameId` | 同上 | **浏览器可信** |
| `sender.tab.id` | 同上 | **浏览器可信** |
| `nonce` | SW 自己签发 | 扩展内部 |
| `entryId` | popup 传入，与 `vault.query` 结果比对 | 扩展内部（已校验） |
| `origin`（授权记录里） | 签发时由 `tabs.get` 规范化得出 | 浏览器可信 |
| 消息正文里的任何 URL/origin | content script / 网页 | **不可信，从不使用** |

### 4.2 修复前的缺口

修复前 `redeemAuth` 只做：

```js
tab = await chrome.tabs.get(rec.tabId);
const liveOrigin = normalize(tab.url);     // ← 只有顶层
```

**没有取目标 frame 的 URL。** 对 `frameId === 0`（主框架）这恰好等价，
所以当时没有可利用漏洞；但一旦支持 iframe 填充，就会变成
"校验顶层、填充子帧"的错配。

### 4.3 现在

```js
const frameInfo = await chrome.webNavigation.getFrame({tabId, frameId});
const frameOrigin = normalize(frameInfo.url);
if (frameOrigin !== rec.origin) → FRAME_ORIGIN_MISMATCH   // 拒绝
...
const topOrigin = normalize(tab.url);
if (topOrigin !== rec.origin) → TOP_ORIGIN_MISMATCH       // 也拒绝
```

**两道都查**：frame 自身 origin + 顶层 origin。
当前只授权 `frameId === 0`，所以两者必须是同一文档，双重校验互为冗余；
将来支持 iframe 时，必须显式放宽 `TOP_ORIGIN_MISMATCH` 并在 UI 上告知用户
（代码注释已写明这一点，避免后人误改）。

---

## 5. iframe 测试结果

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| 主 frame，origin 一致 | **PASS** | 填充成功 |
| **跨 origin iframe**（顶层 example.com，frame evil.test） | **PASS（拒绝）** | `FRAME_ORIGIN_MISMATCH`，`fill`=0 |
| **同域子域 iframe**（`sub.example.com`） | **PASS（拒绝）** | 不自动信任子域 |
| **同域不同端口**（`:8443`） | **PASS（拒绝）** | origin 精确比较 |
| frameId 不匹配 | **PASS（拒绝）** | 认领阶段即挡，**不发起任何浏览器调用** |
| **顶层被导航到别的 origin，frame 仍是授权 origin** | **PASS（拒绝）** | `TOP_ORIGIN_MISMATCH`（本次新增的校验） |
| iframe 导航后 frameId 变化 | **PASS（拒绝）** | 绑定校验挡住 |
| frame 被销毁（`getFrame` 抛错） | **PASS（拒绝）** | `FRAME_GONE` |
| `getFrame` 返回无 url | **PASS（拒绝）** | `FRAME_GONE` |

**真实 iframe 行为（浏览器里实际的 `webNavigation.getFrame` 返回）：NOT TESTED**（需真实浏览器）。

---

## 6. 授权状态机

```text
(无) --issue--> issued
issued --claim(同步, 绑定校验)--> validating
validating --confirm(浏览器侧校验通过)--> consuming
validating --abort/校验失败--> (删除)
consuming --consume--> (删除)
任意 --过期/导航/tab关闭/断连/SW重启--> (删除)
```

| 要求 | 实现 | 状态 |
| --- | --- | --- |
| 独占兑换权 | `claim` 同步推进到 `validating` | **PASS** |
| 单次密码读取 | 只有 `confirm` 成功后调 `fill` | **PASS**（`fill`=1 有测试） |
| 单次消费 | `consume` 删除记录 | **PASS** |
| 失败销毁 | 校验失败 → `invalidate` | **PASS** |
| 过期销毁 | `sweep()` + `claim`/`confirm` 内判断 | **PASS** |
| 导航销毁 | `webNavigation.onCommitted`（frameId 0） | **PASS**（逻辑）；真实事件 **NOT TESTED** |
| tab 关闭销毁 | `tabs.onRemoved` | **PASS**（逻辑）；真实事件 **NOT TESTED** |
| GUI 锁定销毁 | `port.onDisconnect → clear()` + GUI 门禁 | **部分**（见下） |
| SW 重启不恢复 | 新执行环境 + 显式 `clear()` | **PASS**（模拟） |

> **GUI 锁定**：`onDisconnect` 会 `clear()` 全部授权；但"锁定但端口未断"这一路径
> 依赖 GUI 侧 `VAULT_LOCKED` 门禁，需真实 GUI + 真实管道 → **NOT TESTED**。

**不可回退**：`validating` 只能走 `confirm`（→consuming）或 `invalidate`（删除），
没有任何路径回到 `issued`。

---

## 7. 修改文件与提交

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `lib/auth-store.js` | 重写 | 新增 `validating` 态、`claim`/`confirm` 两段、修复并发删记录缺陷 |
| `lib/redeem.js` | **新增** | 兑换流程（依赖注入，可在 node 做真并发测试） |
| `background/service-worker.js` | 修改 | 改为调用 `lib/redeem.js`；`handleRedeem` 变薄封装 |
| `tests/redeem.test.js` | **新增** | 20 项：并发 ×7、frame ×9、状态机 ×4 |
| `docs/KeyNest-Browser-Bridge-Phase2.3-Report.md` | 新增 | 本报告 |

提交：见下方 Git 状态。

---

## 8. 自动化测试结果

```
扩展 node --test   74 通过 / 0 失败
  ├── origin.test.js          12
  ├── origin-parity.test.js    9
  ├── sender.test.js          11
  ├── auth-store.test.js      20
  └── redeem.test.js          22

Rust               223 通过
cargo fmt --all --check  PASS
cargo clippy -D warnings 0 问题
cargo deny check         四类全绿
```

---

## 9. 未测试项目

| 项 | 状态 |
| --- | --- |
| 真实 Chrome 加载扩展 | **BLOCKED** |
| 真实 Edge | **BLOCKED** |
| 真实 `webNavigation.getFrame()` 返回 | **NOT TESTED** |
| 真实 `tabs.onRemoved` / `onCommitted` 事件时序 | **NOT TESTED** |
| 真实 iframe 跨站场景 | **NOT TESTED** |
| GUI 锁定但端口未断时的授权失效 | **NOT TESTED** |
| SW 休眠唤醒后 `sendMessage` 时序 | **NOT TESTED** |
| 真实 Native Messaging / 管道往返 | **BLOCKED** |

**所有 PASS 都是 node 纯逻辑级别。一次真实浏览器都没跑过。**

---

## 10. Git 状态

```
分支        feat/browser-bridge
基线        c1d3faf
本次提交    见 git log -1
main        09b870d（未动）
v0.4.3 Tag  2bd390e（未动）
工作区      提交后干净
未推送 / 未合并 / 未改历史 / 未写注册表 / 未安装扩展
```

---

## 11. 仍存风险

| # | 风险 | 等级 |
| --- | --- | --- |
| 1 | 从未真实浏览器验证 | **高** |
| 2 | 将来支持 iframe 时若放宽 `TOP_ORIGIN_MISMATCH` 而不加 UI 提示 → 跨站填充 | 中（已写注释警示） |
| 3 | `webNavigation` 权限扩大了权限面（仅用于失效与 frame URL） | 低 |
| 4 | JS 字符串与已填入 DOM 的密码无法擦除 | **无法消除** |
| 5 | 同用户恶意进程 | **无法消除** |
