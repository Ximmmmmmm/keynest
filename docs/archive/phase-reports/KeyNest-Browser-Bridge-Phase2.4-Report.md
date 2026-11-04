# KeyNest 浏览器集成 · 阶段 2.4 报告（Chrome 真实运行时验收）

> 分支 `feat/browser-bridge` · HEAD `bd0f1c5` · main `09b870d` 未动 · v0.4.3 Tag `2bd390e` 未动
> 测试环境：**真实 Chrome 156.0.8078.80（Windows 11）**，独立临时 profile，未触碰用户浏览器
> 日期：2026-11-02
> **未写注册表、未注册 Native Host、未推送、未合并、未发布。**

---

## 0. 最重要的结论

**在真实 Chrome 里，扩展能加载、权限可用、消息通路正常、`getFrame` 能拿到真实数据——但填充流程走不通。**

根因：`chrome.tabs.get(tabId).url` 在**没有 host 权限**时**不返回 `url` 字段**。
而 `handleQuery` / `handleAuthorize` / `redeem.js` 全都依赖它。

真实实测返回：

```json
{"ok": false, "error": "NO_ORIGIN"}     ← 即使是 https 页面
```

这不是单元测试能发现的——node 里我注入的 `getTab` 总是返回 `{url: ...}`。

---

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| Chrome | **156.0.8078.80**（真实安装版，非模拟） |
| 加载方式 | CDP `Extensions.loadUnpacked`（`--load-extension` 在 156 已失效） |
| 扩展 ID | `nkmbkncopjdbdleomifkloegjjfpccjk` |
| Profile | 独立临时目录 `%TEMP%\kn-chrome-test2-*`，测试后删除 |
| 测试站点 | 本地自签 HTTPS `https://127.0.0.1:9443/`（含主 frame + 同源 iframe）+ HTTP `http://127.0.0.1:8080/` |
| 驱动方式 | CDP（`Runtime.evaluate` + `Extensions.loadUnpacked`） |
| Native Host | **未注册**（本阶段禁止） |

> `--load-extension` 在 Chrome 156 无效（返回后 `chrome://extensions` 里查无此扩展）。
> 改用 CDP `Extensions.loadUnpacked` 成功加载——这是本次能跑真实测试的关键。

---

## 2. 第一阶段：静态检查结果

| # | 检查项 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | Manifest V3 声明 `webNavigation` | **PASS** | `manifest.json:9` |
| 2 | `getFrame()` 有异常处理 | **PASS** | `lib/redeem.js` try/catch + 无 url 判空 |
| 3 | `sender.documentId` 是否使用 | **未使用** | 见第 4 节风险分析 |
| 4 | 授权绑定 tabId/frameId/documentId/origin/entryId | **部分** | 绑了 4 项，**未绑 documentId** |
| 5 | 异步等待前同步取得独占权 | **PASS** | `auths.claim()` 在首个 await 之前 |
| 6 | 失败/过期/导航/tab关闭/断连销毁 | **PASS** | 代码 + node 测试覆盖 |
| 7 | 消息正文伪造 tab/frame/origin 可能 | **PASS（无）** | 只信 `sender` 与浏览器 API |
| 8 | 日志泄露密码/nonce/密钥 | **PASS（无）** | 无 console 输出敏感值 |

### `documentId` 风险（第 3 项详细）

Chrome 实测 `getFrame()` 返回：

```json
{"frameId":0,"documentId":"173B460CA2A7D92CF7BFCB72F5AC8284",
 "frameType":"outermost_frame","parentFrameId":-1,"url":"https://127.0.0.1:9443/"}
```

iframe 的 documentId 不同：`F0F7DD8B4E5137EB12DEC2ED9EEF991D`。

**风险**：`frameId` 在同一 frame 多次导航间**保持不变**，而 `documentId` 每次导航都换。
当前授权只绑 `tabId + frameId`，所以：

- 用户点填充 → 授权签发（绑 frameId 0）
- 页面导航到同站另一页（frameId 仍为 0）
- 若 `webNavigation.onCommitted` 事件**未及时触发**（SW 休眠），旧授权理论上仍可兑换

**当前实现的兜底**：`redeem.js` 用 `getFrame()` 重新取 frame URL 并比对 origin。
导航到**同 origin** 的另一页时，origin 相同 → 兜底**不会**拦住，但此时填充目标仍是同站，
危害有限。导航到**不同 origin** 则被拦住。

**结论**：`documentId` **未绑定**，属于"已知缺口，当前兜底可接受"。
若要补，见第 7 节方案 B。

---

## 3. 第二阶段：Chrome 真实运行时测试

### A. 扩展加载

| 编号 | 测试 | 预期 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| A1 | MV3 扩展加载 | `manifest_version=3`、`runtime.id` 存在 | `{id:'nkmbkn...', mv:3}` | **PASS（真实）** |
| A2 | `webNavigation` 权限可用 | 权限列表含之 | `['activeTab','nativeMessaging','webNavigation','scripting']` | **PASS（真实）** |
| A3 | Service Worker 启动 | SW target 存在 | `service_worker chrome-extension://nkmb.../background/service-worker.js` | **PASS（真实）** |
| A4 | Manifest 错误 | 无 | 无（扩展正常加载） | **PASS（真实）** |

### B. `tabs` API 权限模型（本次核心发现）

| 编号 | 测试 | 预期 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| B1 | `tabs.query({})` 是否暴露网页 URL | 无 host 权限时**不暴露** | 普通网页 tab 只有 `{id, status}`，**无 `url`/`title`** | **PASS（行为符合预期，但暴露缺陷）** |
| B2 | `tabs.get(id)` 是否返回 `url` | 同上 | `{id:859225340, hasUrl:false}` | **PASS（行为符合预期，但暴露缺陷）** |

### C. Frame 身份

| 编号 | 测试 | 预期 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| C1 | `getAllFrames` 反查 | 能拿到 url + documentId | 主 frame `https://127.0.0.1:9443/`，doc `173B46…`，frames=2 | **PASS（真实）** |
| C2 | `getFrame(0)` 字段 | 含 url/documentId/frameType/parentFrameId | 全部字段齐全 | **PASS（真实）** |
| C3 | iframe 的 documentId 唯一 | 主帧与 iframe 不同 | `173B46…` vs `F0F7DD…` | **PASS（真实）** |
| C4 | 同源 iframe 存在 | 页面含 iframe | frame 16 `https://127.0.0.1:9443/iframe-same` | **PASS（真实）** |

### D. 一次性授权兑换（真实运行时）

| 编号 | 测试 | 预期 | 实际 | 判定 |
| --- | --- | --- | --- | --- |
| D1 | `authorize-fill`（HTTPS 页） | 进入 `vault.query`，因无 Host 报 `NATIVE_HOST_MISSING` | **`{"ok":false,"error":"NO_ORIGIN"}`** | **FAIL（真实缺陷）** |
| D2 | `authorize-fill`（HTTP 页） | 返回 `HTTP_NOT_ALLOWED` | **`{"ok":false,"error":"NO_ORIGIN"}`** | **FAIL（真实缺陷）** |
| D3 | 同一 nonce 兑换两次 | 第二次拒绝 | 无法测（D1 已阻断） | **BLOCKED** |
| D4 | 授权过期 | 拒绝 | 无法测 | **BLOCKED** |
| D5 | 导航后旧授权 | 拒绝 | 无法测 | **BLOCKED** |
| D6 | tab 关闭后 | 拒绝 | 无法测 | **BLOCKED** |

### E. Service Worker 生命周期

| 编号 | 测试 | 结果 |
| --- | --- | --- |
| E1 | 正常启动 | **PASS（真实）**：加载后 SW target 出现 |
| E2 | 休眠 | **PASS（真实）**：无消息时 SW target 消失 |
| E3 | 唤醒 | **PASS（真实）**：打开 popup 后 SW 重新出现 |
| E4 | 休眠期间发消息 | **NOT TESTED** |
| E5 | 重启后旧授权失效 | **NOT TESTED**（无法签发授权） |

---

## 4. 缺陷（真实 Chrome 中发现）

### 缺陷 1（阻断性）：`tabs.get().url` 在无 host 权限时不可用

**最小复现**：

1. 加载扩展（默认权限，未授权任何站点）
2. 打开 `https://127.0.0.1:9443/`
3. 扩展 popup 里发 `{type:'authorize-fill', tabId:<该页 tabId>, entryId:'x'}`

**预期**：`NO_ORIGIN` 之前应先拿到 origin，然后走 `HTTP_NOT_ALLOWED` 或 `vault.query`

**实际**：

```json
{"ok": false, "error": "NO_ORIGIN"}
```

**根因**（`background/service-worker.js:253-255`、`lib/redeem.js`）：

```js
const tab = await chrome.tabs.get(tabId);
const origin = normalize(tab.url || '');     // ← tab.url 为 undefined
if (!origin) return { ok: false, error: 'NO_ORIGIN' };
```

真实 Chrome 返回 `{id: 859225340}`，**没有 `url` 键**。

**影响**：真实浏览器里**填充功能完全不可用**，不只是 iframe 场景。

**为什么单元测试没发现**：node 测试里 `deps.getTab` 是我注入的假实现，总是返回 `{url:'...'}`。
这正是"模拟测试 ≠ 真实测试"的典型例子。

**修复方案 A（推荐，最小改动）**：改用 `webNavigation.getFrame()` 作为 origin 来源。

```js
// 替换 tabs.get(tabId) 拿 origin 的三处
const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
const origin = normalize(frame && frame.url);
```

实测 `getFrame()` **在无 host 权限时也返回真实 url**（见 C2），且不需要新权限
（`webNavigation` 已在 manifest 里）。

需要改的位置：
1. `handleQuery`（service-worker.js:252）
2. `handleAuthorize`（service-worker.js:253 附近）
3. `lib/redeem.js` 的顶层 origin 校验（`TOP_ORIGIN_MISMATCH`）

**修复方案 B（同时补 documentId 绑定，改动较大）**：
在方案 A 基础上，授权记录额外绑定 `documentId`，兑换时比对 `getFrame().documentId`。
这样"同 origin 导航"也能精确失效，不必依赖 `onCommitted` 事件时序。

**我没有实施任何修复**——按阶段规范，发现缺陷应先记录并提方案，等你决定。

---

## 5. 第三阶段：真实填充

**未执行**。原因：D1 已阻断——拿不到 origin 就无法签发授权，无法进入填充流程。

| 项 | 状态 |
| --- | --- |
| 真实填充成功 | **BLOCKED**（被缺陷 1 阻断） |
| 页面加载不自动填充 | **PASS（代码审查）**：无任何 `DOMContentLoaded` 触发的填充 |
| HTTP 拒绝 | **FAIL**（返回 `NO_ORIGIN` 而非 `HTTP_NOT_ALLOW_CORIGIN`） |
| 跨站 iframe 不获密码 | **BLOCKED** |
| 密码不入 storage/日志/剪贴板 | **PASS（代码审查）**，真实运行时 **NOT TESTED** |

---

## 6. 测试结果汇总

### 真实 Chrome PASS（6 项）

| 编号 | 项目 |
| --- | --- |
| A1 | MV3 扩展加载成功 |
| A2 | `webNavigation` 权限可用 |
| A3 | Service Worker 启动 |
| A4 | 无 Manifest 错误 |
| C1 | `getAllFrames` 返回真实 url + documentId |
| C2 | `getFrame(0)` 返回完整字段 |
| C3 | iframe 与主 frame 的 documentId 不同 |
| E1 | SW 正常启动 |
| E2 | SW 休眠（无消息时消失） |
| E3 | SW 唤醒（popup 打开后重现） |

### FAIL（2 项，真实缺陷）

| 编号 | 项目 |
| --- | --- |
| D1 | HTTPS 页面 `authorize-fill` → `NO_ORIGIN` |
| D2 | HTTP 页面 `authorize-fill` → `NO_ORIGIN`（应为 `HTTP_NOT_ALLOWED`） |

### BLOCKED（7 项）

D3 重复兑换、D4 过期、D5 导航后、D6 tab 关闭、第三阶段真实填充、跨站 iframe、密码运行时不泄露验证

### NOT TESTED（3 项）

E4 休眠期间发消息、E5 重启后旧授权、真实 `onCommitted` 时序

### SIMULATED（不计入真实通过）

node 测试 74 项（`auth-store` / `redeem` / `sender` / `origin` 等）——
**全部是模拟，不算真实 Chrome PASS。**

---

## 7. 需要你决定

| # | 事项 | 选项 |
| --- | --- | --- |
| 1 | 修复缺陷 1（改用 `getFrame` 取 origin） | **方案 A**（最小） / **方案 B**（A + documentId 绑定） |
| 2 | 是否同时绑定 `documentId` | 建议**是**（否则同 origin 导航的授权失效依赖事件时序） |
| 3 | 修复后是否再跑一轮真实 Chrome | 建议**是**，且需要 Native Host 才能测到填充 |

**我未修改任何代码。**

---

## 8. 环境保护确认

| 项 | 结果 |
| --- | --- |
| 真实密码库 | **未修改**：`size=42228`、`mtime=2026-11-01 23:19:17`、md5 前 16 位 `2bd94cde0fa7d1e` 与测试前**完全一致** |
| Windows 注册表 | **未写入**：两条 `NativeMessagingHosts\com.keynest.bridge` 均为 `False` |
| `bridge.key` | **未修改**（GUI 未解锁，桥接未启动） |
| 用户 Chrome | **未触碰**：使用独立临时 profile |
| main | 未修改（`09b870d`） |
| v0.4.3 Tag | 未修改（`2bd390e`） |
| 推送/合并/发布 | 均未执行 |
| 测试站点与临时 profile | 已删除 |
| 测试 Chrome 进程 | 已终止（剩余 0） |

---

## 9. Git 状态

```
分支        feat/browser-bridge
HEAD        bd0f1c5（本阶段未提交代码，仅新增本报告）
main        09b870d（未动）
v0.4.3      2bd390e（未动）
工作区      仅 docs/KeyNest-Browser-Bridge-Phase2.4-Report.md（新增）
```

---

## 10. 回答你的完成条件

| 问题 | 答案 |
| --- | --- |
| 所有真实 Chrome PASS 项 | 见第 6 节（10 项，主要是加载/权限/API 行为） |
| BLOCKED/FAIL/NOT TESTED | 见第 6 节 |
| `documentId` 是否可靠绑定 | **否**。当前只绑 tabId+frameId+origin+entryId，未绑 documentId |
| SW 生命周期对一次性授权的影响 | 休眠导致 `onCommitted` 可能不触发 → 同 origin 导航的旧授权可能残留；跨 origin 由 `getFrame` 兜底拦住 |
| 真实密码填充是否成功 | **否**，被缺陷 1 阻断 |
| 是否发现新安全问题 | **未发现安全漏洞**；发现的是**功能性阻断缺陷**（权限模型与代码假设不符） |
| 真实密码库未被修改 | **已确认** |
| 注册表未被修改 | **已确认** |
| main 与 v0.4.3 未被修改 | **已确认** |
| 未推送/合并/发布 | **已确认** |

---

## 11. 这一轮真正的价值

之前的 74 项 node 测试全绿，但**真实 Chrome 一跑就发现填充根本走不通**。

原因是测试里的 `deps.getTab` 是我注入的假实现，永远返回 `{url:'...'}`；
真实 Chrome 在没有 host 权限时**不返回 `url`**。

**这正是"不能把模拟测试当作真实通过"的意义所在。**
