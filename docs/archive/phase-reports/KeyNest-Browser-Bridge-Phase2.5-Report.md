# KeyNest 浏览器集成 · 阶段 2.5 报告（方案 B：API 兼容性修复 + documentId 绑定）

> 分支 `feat/browser-bridge` · 基线 `be74087` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 真实 Chrome **156.0.8078.80**（独立临时 profile）
> 日期：2026-11-02
> **未注册 Native Host、未写注册表、未改 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| `NO_ORIGIN` 阻断 | **已修复**（真实 Chrome 验证：HTTPS 返回 `HOST_DISCONNECTED`，HTTP 返回 `HTTP_NOT_ALLOWED`） |
| origin 是否彻底不依赖 `tabs.get().url` | **是**（全仓 `tabs.get` 仅剩注释） |
| documentId / topDocumentId 绑定 | **已实现**（授权时记录，兑换时重新校验） |
| 同 origin 导航能否让旧授权失效 | **能**（真实 Chrome 验证 documentId 会变） |
| 并发兑换是否仍只成功一次 | **是**（100 并发测试通过） |

---

## 1. `NO_ORIGIN` 根因

**真实 Chrome 行为**（实测）：

```json
[{"id":878836919,"hasUrl":false}, {"id":878836920,"hasUrl":false},
 {"id":878836921,"url":"chrome-extension://.../popup/popup.html","hasUrl":true}]
```

普通网页 tab 的 `chrome.tabs.get(tabId)` **没有 `url` 键**（扩展自己的页面有，因为同源）。

原代码：

```js
const tab = await chrome.tabs.get(tabId);
const origin = normalize(tab.url || '');   // ← undefined → NO_ORIGIN
```

**影响**：真实浏览器里连 HTTPS 页面都拿不到 origin，填充流程完全不可用。

---

## 2. 修复位置（全仓已搜，无遗漏）

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `lib/redeem.js` | 新增 `resolveFrame()` | origin 的唯一来源 |
| `background/service-worker.js` | `handleQuery` | `tabs.get` → `resolveFrame(tabId, 0)` |
| `background/service-worker.js` | `handleAuthorize` | 同上 + 额外取顶层 documentId |
| `background/service-worker.js` | `redeemFillWithChrome` | 移除 `getTab` 注入 |

全仓搜索结果：

```
$ grep -rn "tabs\.get" --include="*.js" .
./background/service-worker.js:168:      // 只用 getFrame：真实 Chrome 无 host 权限时 tabs.get 不返回 url
./background/service-worker.js:267:  // tabs.get(tabId).url 是 undefined，用它必然 NO_ORIGIN。
```

**只剩两行注释，代码依赖已彻底移除。**

---

## 3. documentId / topDocumentId

### 3.1 获取

```js
const targetFrame = await resolveFrame(chromeDeps(), tabId, 0);   // 目标
const topFrame    = await resolveFrame(chromeDeps(), tabId, 0);   // 顶层
```

`resolveFrame()` 返回 `{origin, documentId}`，任一缺失则返回 `null`（**拒绝，不退回只校验 frameId**）。

### 3.2 存储

授权记录新增两个字段：

```js
{
  state: 'issued',
  tabId, frameId,
  documentId,        // 目标 frame 的文档身份
  topDocumentId,     // 顶层文档身份
  origin, entryId, username, expiresAt
}
```

### 3.3 验证（兑换时）

顺序固定：

| 步骤 | 校验 | 失败错误码 |
| --- | --- | --- |
| 1 | 目标 frame 存在 | `FRAME_GONE` |
| 2 | 目标 origin === 记录 origin | `FRAME_ORIGIN_MISMATCH` |
| 3 | **目标 documentId === 记录 documentId** | `DOCUMENT_CHANGED` |
| 4 | 顶层 frame 存在 | `TOP_FRAME_GONE` |
| 5 | **顶层 documentId === 记录 topDocumentId** | `TOP_DOCUMENT_CHANGED` |
| 6 | 顶层 origin === 记录 origin | `TOP_ORIGIN_MISMATCH` |

任一项失败：**销毁授权、不读密码、不可重试**。

### 3.4 真实 Chrome 证据

**documentId 确实会变**（同一 frame 导航前后）：

```
before = 670BF1BFE38338432AF2EBB676A3EBEB
after  = 3FC155ED6327DFB1645C24CAD2448227
```

**主 frame 与 iframe 的 documentId 不同**：

```
frame 0  (outermost_frame) doc=670BF1BFE38338432AF2EBB676A3EBEB
frame 15 (sub_frame)       doc=E7C9BF9D67DE8E002EF74E875711DF17
```

→ **同 origin 导航能让旧授权失效**（不必依赖 `onCommitted` 事件时序）。

---

## 4. 并发安全未退化

- `auths.claim()` 仍是**同步**调用，位于所有 `await` 之前
- 状态机保持 `issued → validating → consuming → consumed`
- 已认领后只返回 `null`，**不删除记录**（不破坏合法请求）
- 仅 `issued` 状态下绑定不符才销毁

100 并发测试断言：成功 1 次、`fill` 调用 1 次、`getFrame` 调用 2 次（目标+顶层各一次）。

---

## 5. 测试结果

### A. Node 单元测试（**75 通过 / 0 失败**）

| 文件 | 数量 |
| --- | --- |
| `origin.test.js` | 12 |
| `origin-parity.test.js` | 9 |
| `sender.test.js` | 11 |
| `auth-store.test.js` | 20 |
| `redeem.test.js` | **23** |

新增/更新的关键用例：

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | `tabs.get` 不返回 url、`getFrame` 返回 url → 正常通过 | **PASS** |
| 2 | `getFrame` 返回 null | **PASS** |
| 3 | `getFrame` 抛异常 | **PASS** |
| 4 | 目标 frame documentId 不一致 → 拒绝 | **PASS** |
| 5 | 顶层 documentId 不一致 → 拒绝 | **PASS** |
| 6 | 同 origin 导航但 documentId 改变 → 失效 | **PASS** |
| 7 | 跨 origin 导航 → 拒绝 | **PASS** |
| 8 | frameId 不变但 documentId 改变 → 拒绝 | **PASS** |
| 9 | 顶层 documentId 变、目标 origin 不变 → 拒绝 | **PASS** |
| 10 | documentId 缺失 → 拒绝（不退回 frameId） | **PASS** |
| 11 | 两个 documentId 均匹配 → 兑换成功 | **PASS** |
| 12 | 任一 documentId 不匹配 → **`fill` 调用次数为 0** | **PASS** |
| 13 | 100 并发仍只成功一次 | **PASS** |
| 14 | 验证失败后旧 nonce 不可再用 | **PASS** |

**全部断言了 `fill` 调用次数**，不只是断言返回错误。

### B. 真实 Chrome 测试

| 编号 | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| S1 | 扩展加载（CDP `Extensions.loadUnpacked`） | **PASS（真实）** | id `nkmbkncopjdbdleomifkloegjjfpccjk` |
| S2 | HTTPS 测试页加载 | **PASS（真实）** | `https://127.0.0.1:9444/` |
| S3 | `tabs.get` 对普通网页无 url | **PASS（真实）** | 两个 `hasUrl:false`（扩展页有 url，同源） |
| S4 | `getFrame` 返回 url + documentId | **PASS（真实）** | `{url:'https://127.0.0.1:9444/', doc:'670BF1BF…'}` |
| S5 | 主 frame 与 iframe documentId 不同 | **PASS（真实）** | 两个不同 docId |
| S6 | 同 frame 导航后 documentId 变化 | **PASS（真实）** | `670BF1BF…` → `3FC155ED…` |
| S7 | 修复后 HTTPS `authorize-fill` | **PASS（真实）** | `{ok:false, error:'HOST_DISCONNECTED'}`（已过 origin 校验，卡在 Host） |
| S8 | 修复后 HTTP `authorize-fill` | **PASS（真实）** | `{ok:false, error:'HTTP_NOT_ALLOWED'}` |

**S7/S8 是修复有效的决定性证据**：修复前两者都是 `NO_ORIGIN`。

### C. Rust 门禁

```
cargo test --workspace   223 通过
cargo fmt --all --check  PASS
cargo clippy -D warnings 0 问题
cargo deny check         四类全绿
```

---

## 6. 仍 BLOCKED / NOT TESTED

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实密码填充 | **BLOCKED** | 需注册 Native Host（本阶段禁止） |
| 真实一次性兑换（同 nonce 第二次） | **BLOCKED** | 需先签发授权 → 需 Host |
| 授权过期 / tab 关闭 / 导航后真实失效 | **BLOCKED** | 同上 |
| 跨站 iframe 真实拒付 | **BLOCKED** | 同上 |
| 密码运行时不入 storage/日志 | **NOT TESTED** | 仅代码审查 |
| `webNavigation.onCommitted` 真实时序 | **NOT TESTED** | SW 休眠时可能不触发（documentId 已兜底） |
| SW 休眠期间发消息 | **NOT TESTED** | — |

**所有 BLOCKED 都指向同一件事：需要 Native Host。**

---

## 7. 环境保护

| 项 | 结果 |
| --- | --- |
| 真实密码库 | `size=42228`、md5 前 16 位 `2bd94cde0fa7d1e`，**与测试前一致** |
| 注册表 | 两条 `NativeMessagingHosts\com.keynest.bridge` 均 `False`，**未写入** |
| `bridge.key` | 未修改（GUI 未解锁） |
| 用户 Chrome | **未触碰**（独立临时 profile，测试后删除） |
| main / v0.4.3 | `09b870d` / `2bd390e`，未动 |
| 推送 / 合并 / 发布 | 均未执行 |
| 测试进程与临时目录 | 已清理（剩余 0） |

---

## 8. Git

```
分支        feat/browser-bridge
基线        be74087
本次提交    见 git log -1
main        09b870d（未动）
v0.4.3      2bd390e（未动）
工作区      提交后干净
```

---

## 9. 测试总数

| 类别 | 数量 |
| --- | --- |
| Node 单元测试 | **75** |
| Rust 测试 | **223** |
| **合计** | **298** |
| 真实 Chrome 测试 | **8 项 PASS**（S1–S8） |
| BLOCKED | 4 项 |
| NOT TESTED | 3 项 |

---

## 10. 下一步需要你批准

真实填充验证需要注册 Native Host。这四件事都卡在同一个前置条件上：

1. 一次性兑换（第二次被拒）
2. 授权过期失效
3. 导航后旧授权失效（真实事件路径）
4. 跨站 iframe 不获密码

**在你批准注册 Native Host 之前，这些只能保持 BLOCKED。**
