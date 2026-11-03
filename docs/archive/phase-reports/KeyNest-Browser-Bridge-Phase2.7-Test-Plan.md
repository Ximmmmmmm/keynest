# KeyNest 阶段 2.7 · 浏览器授权安全边界测试方案与审查清单

> 基线 `d042d28`（阶段 2.6.1）· 分支 `feat/browser-bridge` · 工作区干净
> main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> **本阶段只审查与设计。未改代码、未建提交、未注册 Host、未启动 GUI。**

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 六项安全边界的代码审查 | 5 项通过，**1 项有缺陷**（TTL 用墙上时钟） |
| 是否存在必须先修的代码缺陷 | **有 1 个（中）**：`Date.now()` 非单调 |
| 是否建议批准真实 Chrome 测试 | **建议批准**，但建议先修 TTL |
| 真实 Chrome 可执行的测试 | 4 / 6 项可完整执行；2 项部分依赖时序控制 |

---

## 1. Git 基线

```
分支        feat/browser-bridge
HEAD        d042d28（阶段 2.6.1 锁文件提交）
上一提交    4f9c347（阶段 2.6.1 主提交）
工作区      干净
main        09b870d（未动）
v0.4.3      2bd390e（未动）
```

---

## 2. 第一部分：六项安全边界代码审查

### A. 跨站 iframe

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | Content Script 能否在跨站 iframe 中发起兑换 | **不能** | `manifest.json` `all_frames: false`——只在主 frame 注入 |
| 2 | SW 是否可信取得发送方 frame 身份 | **是** | `sender.tab.id` / `sender.frameId` / `sender.url` 均为 Chrome 注入 |
| 3 | 是否用 `getFrame()` 取真实 frame URL | **是** | `redeem.js:34 resolveFrame()` → `webNavigation.getFrame` |
| 4 | 是否重新验证顶层 frame | **是** | `redeem.js:88 resolveFrame(deps, rec.tabId, 0)` |
| 5 | 是否严格校验目标 frame origin | **是** | `target.origin !== rec.origin → FRAME_ORIGIN_MISMATCH` |
| 6 | 子域/不同端口/协议降级绕过 | **无** | `origin.js normalize()` 精确比较，子域与端口均视为不同 origin |
| 7 | frame 导航/销毁/替换后旧授权失效 | **是** | `documentId` 比对 + `webNavigation.onCommitted` |
| 8 | 是否信任消息体里的身份字段 | **否** | `claimed` 里 `tabId/frameId/origin` 全部来自 `sender`，`documentId` 由 `getFrame` 重取 |

**结构性结论**：当前架构**根本不支持 iframe 填充**——
`issueAuth` 里 `const frameId = 0`（service-worker.js:301）硬编码，
content script 又只在主 frame 注入。所以"跨站 iframe 拒绝"是**结构性成立**的，
不依赖运行时校验。

这既是优点（攻击面小），也是限制（同源 iframe 登录框也填不了）。

**遗留观察**：`sender.documentId` **未被使用**。当前设计靠 `getFrame()` 重取，
安全上等价（甚至更可信），但少了一道交叉验证。属**可加固项，非缺陷**。

---

### B. 导航后旧授权失效

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 授权时记录目标 documentId | **是** | `issueAuth({... documentId: targetFrame.documentId})` |
| 2 | 记录 topDocumentId | **是** | `topDocumentId: topFrame.documentId` |
| 3 | 兑换前重查目标 frame | **是** | `redeem.js:72` |
| 4 | 重查顶层 frame | **是** | `redeem.js:88` |
| 5 | 目标 documentId 严格相等 | **是** | `target.documentId !== rec.documentId → DOCUMENT_CHANGED` |
| 6 | 顶层 documentId 严格相等 | **是** | `top.documentId !== rec.topDocumentId → TOP_DOCUMENT_CHANGED` |
| 7 | origin 严格相等 | **是** | 三处 origin 比较 |
| 8 | 查询失败时安全拒绝 | **是** | `resolveFrame` 返回 null → `FRAME_GONE` / `TOP_FRAME_GONE` |
| 9 | 无 documentId 时拒绝而非退回 frameId | **是** | `resolveFrame` 里 `if (!info.documentId) return null` |

**覆盖场景分析**：

| 场景 | 结果 |
| --- | --- |
| 同 origin 页面跳转 | **拒绝**（documentId 变了，origin 没变也拦得住） |
| 不同 origin 跳转 | **拒绝**（documentId + origin 双重） |
| 主 frame 导航 | **拒绝**（`onCommitted` 立即清 + documentId 兜底） |
| iframe 导航 | **不影响主 frame 授权**（当前只授权 frameId 0） |
| frame 销毁后重建 | **拒绝**（documentId 必不同） |
| **SPA history 变化（pushState）** | **不失效**（documentId 不变，这是**正确行为**——文档没换，只是 URL 变了） |

> SPA 那一条需要真实测试确认：`pushState` 后 `tab.url` 变了但 `documentId` 没变。
> 此时 origin 可能变（如 `/a` → `/b` 同 origin 则不变）。**预期：不失效，仍可填充**。
> 这是合理语义（同一文档、同一 origin），但要在测试中显式确认。

---

### C. 5 秒 TTL —— **发现缺陷**

| # | 检查项 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | TTL 由可信时间源计算 | **否** | 用 `Date.now()` |
| 2 | **是否用单调时钟** | **❌ 否** | `new AuthStore(() => Date.now(), AUTH_TTL_MS)`（service-worker.js:43） |
| 3 | 过期判断是否严格 | **是** | `expiresAt <= now`（`<=` 意味着到期即失效，正确） |
| 4 | 时钟精度/边界/溢出 | **有隐患** | 见 2.1 |
| 5 | 过期后清理记录 | **是** | `sweep()` + `claim`/`confirm` 内判断 |
| 6 | 并发兑换与过期清理竞态 | **安全** | JS 单线程，`sweep` 与 `claim` 不会交错 |
| 7 | 过期请求是否可能已进 consuming 后取密码 | **不会** | `confirm()` 里也查 `expiresAt` |

#### 2.1 缺陷详述（等级：中）

```js
const auths = new AuthStore(() => Date.now(), AUTH_TTL_MS);   // ← 墙上时钟
```

`Date.now()` 受**系统时间调整**影响：

| 场景 | 后果 |
| --- | --- |
| 用户把系统时间**往前拨**（如 10 分钟） | `now` 变小 → `expiresAt <= now` 不成立 → **授权永不过期**（理论上可用到 SW 重启） |
| 用户把系统时间**往后拨**（如 1 小时） | `now` 变大 → **所有授权立即过期**（功能暂时不可用，但安全方向正确） |
| NTP 校时回退 | 同上，可能让某次授权意外延长 |

**实际危害评估**：危害有限但真实——
`nonce` 仍需正确绑定 tab/frame/documentId/origin/entryId，
且 SW 休眠/重启会清空。**但它违反了"短时一次性授权"的时间保证**。

**为什么之前没暴露**：所有 node 测试都注入假时钟（`new AuthStore(() => t, TTL)`），
测试用的是递增的计数器，**恰好是单调的**——所以测试永远测不出这个问题。

**最小修复方案**（**本阶段不实施，待批准**）：

```diff
-const auths = new AuthStore(() => Date.now(), AUTH_TTL_MS);
+// 单调时钟：不受系统时间调整影响。
+// performance.now() 在 SW 里可用，且单调递增（不随 NTP/时区/手动改时间跳变）。
+// 注意：它返回相对页面/上下文启动的毫秒数，SW 重启会归零——
+// 但 SW 重启时 auths 本就清空，所以两者语义一致。
+const clock = () => performance.now();
+const auths = new AuthStore(clock, AUTH_TTL_MS);
```

改动 1 行 + 注释。影响范围：仅 `service-worker.js`。

**验证方式**：node 测试可注入 `performance.now()` 或假时钟；
真实 Chrome 里用 `chrome.debugger` 或直接改系统时间验证（后者风险高，不建议）。

#### 2.2 边界行为（4.9s / 5.0s / 5.1s）

当前实现：

```js
expiresAt = now + 5000
// 判定：expiresAt <= now → 过期
```

| 时刻 | `expiresAt <= now` | 结果 |
| --- | --- | --- |
| 4.9s | false | **有效** |
| 5.0s | **true**（`<=`） | **过期** |
| 5.1s | true | 过期 |

语义正确（5 秒整即失效）。需在测试里显式断言 5.0s 边界。

---

### D. Tab 关闭

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 监听 `tabs.onRemoved` | **是** | service-worker.js:181 |
| 2 | 清理该 tab 全部待兑换授权 | **是** | `auths.invalidateTab(tabId)` |
| 3 | Tab 关闭与 redeem 并发谁先拿到所有权 | **redeem 先则可能完成；关闭先则授权消失** | JS 单线程，两者按事件顺序串行；无交错 |
| 4 | 同 ID/新 ID Tab 重建后旧授权复用 | **不可能** | 记录已删；即使 tabId 复用，`documentId` 也不同 |
| 5 | 清理失败是否泄漏 | **不会** | 清理是纯 Map 删除，无失败路径 |

**边界**：若 `redeem` 已进入 `consuming` 且正在 `await fill`，
此时 tab 关闭 → `invalidateTab` 删记录 → 但 `confirm` 已返回 `confirmed` 对象，
密码仍会被取出并返回给已关闭的 tab（`sendMessage` 会失败，密码不落地）。
**结论：不会泄漏到页面**，但密码在内存里多存活一次往返。属可接受。

---

### E. Service Worker 休眠与唤醒

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 休眠时 pending nonce 是否丢失 | **丢失（设计如此）** | `auths` 是内存 Map，SW 结束即消失 |
| 2 | 重启后能否恢复旧授权 | **不能** | 内存为空 + 显式 `auths.clear()`（service-worker.js:192） |
| 3 | 是否有持久化 pending nonce | **无** | 全仓无 `storage` / `localStorage` / `indexedDB` 写入 |
| 4 | Port 断开后是否正确处理 | **是** | `onDisconnect` → `auths.clear()` + 清 inflight |
| 5 | 唤醒后能否重放旧消息 | **不能** | nonce 已不存在 |
| 6 | 重复消息是否产生第二次兑换 | **不能** | `claim` 状态机 + `consuming` 不可回退 |
| 7 | 生命周期变化时是否清理密码引用 | **是** | `res.password = null` + popup `window.close()` |
| 8 | 事件监听器是否顶层同步注册 | **是** | 三个监听器均在模块顶层（181/185/198 行） |

**关键设计确认**：SW 重启**不恢复状态**是刻意的（注释写明"有意为之而非巧合"）。
这符合"不得通过持久化密码或 nonce 换取状态恢复"的要求。

**风险**：SW 在用户点"填充"与 content script 兑换之间休眠 →
nonce 丢失 → 兑换失败（`AUTH_REJECTED`）。**功能影响，非安全问题**。
真实 Chrome 中 SW 有 30 秒空闲上限，5 秒 TTL 内休眠概率低但不为零。

---

### F. 并发兑换

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 第一个 await 之前同步 claim | **是** | `redeem.js:68` 在 `:72` 的 await 之前 |
| 2 | 只有一个并发请求成功 | **是** | node 测试 100 并发只有 1 成功 |
| 3 | 其他并发请求安全拒绝 | **是** | 返回 `AUTH_REJECTED`，且**不删记录**（防 DoS） |
| 4 | 两请求同时读到 issued 的窗口 | **不存在** | JS 单线程，`claim` 内无 await |
| 5 | 请求超时后状态未清理 | **会清理** | 各失败分支均调 `invalidate` |
| 6 | 异常分支跳过 finally 清理 | **无 finally**，但每分支显式清理 | 需逐分支核对（见下） |
| 7 | 同一 nonce 对不同 entryId/tab/frame/origin 兑换 | **不可能** | `claim` 比对四项绑定值，不符即销毁 |

**逐分支清理核对**（`redeem.js`）：

| 分支 | 清理 |
| --- | --- |
| `claim` 失败 | 无需清理（未认领） |
| `resolveFrame` 目标失败 | `invalidate` ✅ |
| 目标 origin 不符 | `invalidate` ✅ |
| 目标 documentId 不符 | `invalidate` ✅ |
| 顶层 frame 失败 | `invalidate` ✅ |
| 顶层 documentId 不符 | `invalidate` ✅ |
| 顶层 origin 不符 | `invalidate` ✅ |
| `confirm` 失败 | 记录已被外部删除，无需清理 ✅ |
| `fill` 抛错 | `invalidate` ✅ |
| 密码为空 | `invalidate` ✅ |
| 成功 | `consume` ✅ |

**无遗漏分支。**

---

## 3. 第二部分：六项测试设计

证据等级定义：

- `REAL_CHROME` — 真实 Chrome 进程、真实扩展、真实事件
- `REAL_NATIVE_HOST` — 真实 `keynest-native-host.exe` 进程
- `REAL_GUI` — 真实 `keynest-egui.exe` + 真实命名管道 + 真实临时库
- `NODE_SIMULATED` — node 里用假 `chrome.*` 依赖
- `UNIT_TEST` — 纯函数

---

### 测试 1：跨站 iframe 拒绝

| 项 | 内容 |
| --- | --- |
| **目的** | 确认跨站 iframe 中的登录框**不会**被填充 |
| **前置** | 真实 Chrome + 扩展 + GUI 解锁；页面 A（`https://127.0.0.1:9445/`）内嵌跨站 iframe（`https://localhost:9446/`，**不同 origin**） |
| **步骤** | 1. 打开页面 A，iframe 内含密码框<br>2. 点扩展 → 应只列出 A 的条目<br>3. 执行填充<br>4. 用 CDP 读 iframe 内 `input.value` |
| **PASS** | 主 frame 被填充；**iframe 内为空** |
| **拒绝码** | 若强行向 iframe 发 `prepare-fill`：`ORIGIN_MISMATCH` |
| **证据** | 主/子 frame 的 `documentId`、`frameId`、`url`；iframe `input.value` 长度 |
| **假阳性** | iframe 未加载完就读值 → 空值误判为"拒绝"。**须先等 iframe `load`** |
| **可执行层** | `REAL_CHROME` + `REAL_GUI`（结构性验证可 `UNIT_TEST`） |

---

### 测试 2：导航后旧授权失效

| 项 | 内容 |
| --- | --- |
| **目的** | 同 origin 跳转、不同 origin 跳转、SPA pushState 三种情况下的授权生命周期 |
| **前置** | 页面 A（`/`）与 A2（`/other`，同 origin）、B（`https://localhost:9446/`，跨 origin） |
| **步骤（同 origin）** | 1. 在 A 点填充 → 拿到 nonce（不兑换）<br>2. `location.href = '/other'`<br>3. 用旧 nonce 兑换 |
| **PASS（同 origin）** | 拒绝，`DOCUMENT_CHANGED` 或 `AUTH_REJECTED`（`onCommitted` 已清） |
| **步骤（跨 origin）** | 同上，跳到 B |
| **PASS（跨 origin）** | 拒绝 |
| **步骤（SPA）** | 在 A 执行 `history.pushState({}, '', '/spa')`，**不换文档** |
| **预期（SPA）** | **不失效**——documentId 未变，同一文档仍可填充 |
| **证据** | 三个时刻的 `getFrame().documentId`；兑换返回码 |
| **假阳性** | `onCommitted` 与 `pushState` 混淆——pushState **不触发** `onCommitted`，若测出"SPA 失效"说明误判 |
| **可执行层** | `REAL_CHROME`（`onCommitted` 真实事件）；`NODE_SIMULATED` 可覆盖 documentId 比对 |

---

### 测试 3：5 秒 TTL 真实过期

| 项 | 内容 |
| --- | --- |
| **目的** | 验证 4.9s 有效 / 5.0s 失效 / 5.1s 失效 |
| **前置** | GUI 解锁 |
| **步骤** | 1. 签发授权，记 `t0`<br>2. 在 4.9s 兑换 → 应成功<br>3. 重新签发，在 5.0s 兑换 → 应失败<br>4. 重新签发，在 5.1s 兑换 → 应失败 |
| **拒绝码** | `AUTH_REJECTED`（记录已被 sweep 或 claim 时判过期） |
| **证据** | 每次的时间戳（`performance.now()` 差值）、返回码 |
| **假阳性** | **CDP `evaluate` 往返延迟**可能让"4.9s"实际跨过 5s 边界 → 误判为失败。须记录实际耗时，容差 ±100ms |
| **可执行层** | `REAL_CHROME`（真实 SW 时钟）；`UNIT_TEST` 已覆盖逻辑 |
| **⚠️ 缺陷** | 当前用 `Date.now()`，**测试期间若系统时间被调整会误判**。建议先修（见 2.1） |

---

### 测试 4：Tab 关闭后授权失效

| 项 | 内容 |
| --- | --- |
| **目的** | 确认 `tabs.onRemoved` 真实清理 |
| **步骤** | 1. 签发授权<br>2. `chrome.tabs.remove(tabId)`<br>3. 用旧 nonce 兑换 |
| **PASS** | `AUTH_REJECTED`（记录已删） |
| **证据** | 关闭前后的 `auths.size()`（需临时暴露或从行为推断）、兑换码 |
| **假阳性** | tab 关闭与兑换竞态：若兑换先完成则 PASS 但测的不是关闭路径。**须确保兑换在关闭之后发起** |
| **可执行层** | `REAL_CHROME`；`NODE_SIMULATED` 可覆盖 `invalidateTab` |

---

### 测试 5：Service Worker 休眠、唤醒与状态恢复

| 项 | 内容 |
| --- | --- |
| **目的** | 确认 SW 重启后旧授权不可恢复，且不持久化任何敏感状态 |
| **步骤** | 1. 签发授权<br>2. 通过 `chrome://serviceworker-internals` 或 `chrome.debugger` 停止 SW<br>3. 唤醒（发消息）<br>4. 用旧 nonce 兑换 |
| **PASS** | `AUTH_REJECTED`；且 `chrome.storage` 不存在（无持久化） |
| **证据** | SW target 的 `attach/detach` 记录；兑换码；`typeof chrome.storage` |
| **假阳性** | SW 未真正停止（Chrome 可能立即重启）→ 记录仍在 → 误判"恢复了"。**须确认 SW 进程真的消失**（CDP target 列表） |
| **可执行层** | `REAL_CHROME`。**这是最难可靠执行的一项**——SW 生命周期由浏览器控制 |

---

### 测试 6：真实浏览器下的并发兑换

| 项 | 内容 |
| --- | --- |
| **目的** | 确认真实 SW 里 100 并发只有 1 次成功、密码只读 1 次 |
| **步骤** | 1. 签发授权<br>2. 在 SW 上下文里 `Promise.all` 发起 100 个 `redeem-fill`<br>3. 统计成功数、`vault.fill` 调用次数 |
| **PASS** | 成功 1 / 拒绝 99；GUI 侧 `fill` 只被调用 1 次 |
| **证据** | 成功/失败计数；GUI 日志里 `vault.fill` 次数（需临时加日志或从 Native Host 侧统计） |
| **假阳性** | 若 100 个请求被 Chrome 排队而非真并发 → 测不出竞态。**须确认 `Promise.all` 真的同时发出**（JS 语义保证，但 SW 消息队列可能串行化） |
| **可执行层** | `REAL_CHROME`（SW 内真并发）+ `REAL_GUI`（统计 fill 次数）；`NODE_SIMULATED` 已覆盖 |

---

## 4. 第三部分：真实 Chrome 测试环境规划

### 4.1 目录结构

```
%TEMP%\KeyNest-Phase2.7-Test\
├── data\          ← KEYNEST_DATA_DIR 指向这里（vault.dat + bridge.key）
├── manifest\      ← Native Host manifest
├── bin\           ← keynest-native-host.exe
├── profile\       ← 独立 Chrome profile
├── site-a\        ← https://127.0.0.1:9445/（主站，含同源 iframe）
├── site-b\        ← https://localhost:9446/（跨站 iframe 源）
└── logs\
```

### 4.2 两个 origin 的实现

| 站点 | URL | 说明 |
| --- | --- | --- |
| A | `https://127.0.0.1:9445/` | 主测试页，含登录框 + 同源 iframe（`/iframe`）+ 跨站 iframe（指向 B） |
| B | `https://localhost:9446/` | 跨站源，含登录框；用于 iframe 与跨 origin 导航测试 |

**为什么这样能造出不同 origin**：`127.0.0.1` 与 `localhost` 在 origin 语义上是**不同 host**，
因此 `https://127.0.0.1:9445` ≠ `https://localhost:9446`（host 与 port 都不同）。

自签证书需包含两个 SAN：`IP:127.0.0.1` 与 `DNS:localhost`。

### 4.3 环境变量继承（**必须明确说明**）

**关键事实**：

1. **Chrome 启动 Native Host 时，Host 继承的是 Chrome 进程的环境**，
   不是"当前 shell"的环境。
2. 给 GUI 设 `KEYNEST_DATA_DIR` **不会**影响已经在运行的 Chrome。
3. 因此必须**先设好环境变量，再启动 Chrome**；或让 Chrome 自己带着变量启动。

推荐顺序：

```powershell
$env:KEYNEST_DATA_DIR = "<临时>\data"      # 1. 先设变量
Start-Process chrome.exe -ArgumentList ...  # 2. 再启动 Chrome（继承变量）
# 3. 用同一变量启动 GUI
```

**若顺序搞错**（先启动 Chrome，再设变量启动 GUI）→ 两者目录不同 → 握手失败。

这不是代码缺陷，是**进程环境继承的固有行为**，测试文档必须写清。

### 4.4 注册与清理

- 只注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge`
- **不注册 Edge**
- 用 `-ManifestDir` 指向临时目录
- 测试后 `-Uninstall` 清理

### 4.5 禁止项

- 不使用真实 vault.dat / 真实主密码
- 不触碰真实 `bridge.key`
- 不启动真实数据目录下的 GUI

---

## 5. 第四部分：目录指纹问题的诊断限制（仅记录，不实施）

**现状**：

- `keynest-paths` 已统一**解析逻辑**（一份实现）
- 但**不能保证两个进程的环境变量相同**
- 环境不同 → 目录不同 → 读不同 `bridge.key` → 握手失败

**当前可用的诊断手段**：

| 手段 | 信息量 |
| --- | --- |
| Host stderr `keynest-native-host: HANDSHAKE` | 只知道"握手失败"，不知原因 |
| GUI stderr `keynest-bridge: serve 结束: ...` | 同上 |
| 手工核对 `%TEMP%` 下是否有第二份 `bridge.key` | 可确认，但需用户操作 |

**本阶段明确不做**：

- ❌ 不加路径 SHA-256 前缀
- ❌ 不改 `status` 响应协议
- ❌ 不加任何指纹字段

**独立建议**（列入报告，不实施）：

`status` 回包增加 `data_dir_tag`（如路径的 SHA-256 前 8 位，**不可逆推路径**），
扩展与设置页比对后提示"GUI 与 Host 数据目录不一致"。

代价：协议版本从 1 升到 2，需同步改 Rust 侧与扩展侧。**应单独批准。**

---

## 6. 失败场景与错误码汇总

| 场景 | 错误码 | 层 |
| --- | --- | --- |
| 目标 frame 不存在 | `FRAME_GONE` | SW |
| 目标 frame origin 不符 | `FRAME_ORIGIN_MISMATCH` | SW |
| 目标 documentId 变了 | `DOCUMENT_CHANGED` | SW |
| 顶层 frame 不存在 | `TOP_FRAME_GONE` | SW |
| 顶层 documentId 变了 | `TOP_DOCUMENT_CHANGED` | SW |
| 顶层 origin 不符 | `TOP_ORIGIN_MISMATCH` | SW |
| nonce 不存在/已消费/绑定不符 | `AUTH_REJECTED` | SW |
| 期间被 abort | `AUTH_ABORTED` | SW |
| 密码为空 | `NO_PASSWORD` | SW |
| HTTP 页面 | `HTTP_NOT_ALLOWED` | SW |
| 条目不属于该 origin | `ENTRY_NOT_MATCHED` | SW |
| GUI 锁定 | `VAULT_LOCKED` | GUI |
| Host 连不上 GUI | `HOST_DISCONNECTED` | Host |
| 握手失败 | `HANDSHAKE` | Host/GUI |

---

## 7. 可能的竞态与假阳性

| # | 假阳性来源 | 规避方法 |
| --- | --- | --- |
| 1 | iframe 未加载完就读值 → 误判"拒绝" | 等 `load` 事件或轮询 `readyState` |
| 2 | CDP `evaluate` 往返延迟跨过 5s 边界 | 记录实际耗时，容差 ±100ms |
| 3 | SW 未真正停止（Chrome 立即重启） | 用 CDP target 列表确认 SW 消失 |
| 4 | `Promise.all` 被消息队列串行化 | 在 SW 内部直接调函数（不经 `sendMessage`） |
| 5 | `pushState` 被误认为导航 | 断言 `documentId` 未变 |
| 6 | tab 关闭与兑换竞态 | 确保兑换在 `tabs.remove` 完成之后发起 |
| 7 | **系统时间被调整**（TTL 用 `Date.now`） | 测试期间不改系统时间；或先修缺陷 |

---

## 8. 尚未解决的风险

| # | 风险 | 等级 | 说明 |
| --- | --- | --- | --- |
| 1 | **TTL 用墙上时钟** | **中** | 改系统时间可延长/缩短授权有效期（见 2.1） |
| 2 | 两进程环境分叉 | 中 | 已记录，本阶段不修 |
| 3 | SW 休眠导致 nonce 丢失 | 低 | 功能影响，非安全 |
| 4 | `sender.documentId` 未使用 | 低 | 靠 `getFrame` 重取，安全等价 |
| 5 | iframe 填充结构性不支持 | 低 | 设计选择，非缺陷 |
| 6 | JSON 明文 `String` 未 `Zeroizing` | 低 | 阶段 2.6 已记录 |

---

## 9. 是否存在必须先修的代码缺陷

**有 1 个**：

### TTL 使用 `Date.now()`（墙上时钟）

| 项 | 内容 |
| --- | --- |
| 位置 | `service-worker.js:43` |
| 问题 | 系统时间调整会改变授权有效期 |
| 等级 | **中** |
| 最小修复 | 改用 `performance.now()`（1 行） |
| 影响范围 | 仅 `service-worker.js` |
| 测试影响 | node 测试注入假时钟，**不会因此失败**（假时钟本就单调） |

**建议：先修这个，再跑真实 Chrome 测试。**
否则 TTL 测试（测试 3）可能在系统时间被调整时给出错误结论。

---

## 10. 是否建议批准真实 Chrome 测试

**建议批准**，理由：

1. 六项中五项代码审查通过，无阻塞性缺陷
2. 唯一缺陷（TTL 时钟）可 1 行修复，且不影响其他测试
3. 测试环境方案已完整（两个 origin、独立 profile、临时库、明确的环境变量顺序）
4. 4 项可完整执行（iframe、导航、TTL、并发），2 项执行难度较高（tab 关闭、SW 休眠），但可降级为 `NODE_SIMULATED` + 部分真实证据

**批准前建议**：

1. 先批准修复 TTL 时钟（1 行）
2. 确认环境变量启动顺序（先设变量再启 Chrome）
3. 明确测试 5（SW 休眠）若无法可靠执行，是否接受标 `BLOCKED`

---

## 11. 停止点

**本阶段只做审查与设计。**

- 未修改任何代码
- 未创建任何提交
- 未注册 Native Host / Edge
- 未启动 GUI / 真实密码库
- 未读取或修改真实 vault.dat / bridge.key
- 未创建临时测试环境
- 未推送、未合并、未发布
- main 与 v0.4.3 未动
