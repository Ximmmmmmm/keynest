# KeyNest 浏览器集成 · 阶段 2.2 报告（缺陷 A/B/C 修复）

> 分支 `feat/browser-bridge` · 基线 HEAD `f20475b` · main `09b870d` 未动 · v0.4.3 Tag `2bd390e` 未动
> 日期：2026-11-02
> **未写注册表、未执行注册脚本、未加载扩展、未访问真实密码库。**

---

## 1. A/B/C 修复前后对照

| # | 缺陷 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| **A** | content script 用 `startsWith` 判 origin | `here.startsWith(msg.origin)` → `https://example.com.evil.test` 会匹配 `https://example.com` | 用 `normalizeOrigin()` 规范化后**严格相等**比较；与 Rust/JS 三处实现共用同一语料测试 |
| **B** | 用 `sender.tab` 存在与否判身份 | `!sender.tab` 当作"特权页面" → `options_ui` 开在标签页时被误判成 content script，**功能坏**；判据本身不可信 | 新增 `lib/sender.js::classifySender`：`sender.id` + `sender.url` **精确分类**（扩展 base 前缀 + 页面路径白名单）。`sender.tab` 只用来区分 content，不再用于特权判定 |
| **C** | 令牌创建后立即删除，从未验证 | 生成 nonce → 存 Map → 立即 `delete`，**从未校验过**；密码随 `do-fill` 一起下发 | 真正的状态机（`lib/auth-store.js`）：`issued → consuming → consumed`，两段式兑换，密码**只在兑换通过后才取** |

---

## 2. 修改文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `browser-extension/lib/auth-store.js` | 新增 | 授权状态机（纯逻辑，可测） |
| `browser-extension/lib/sender.js` | 新增 | 消息来源分类（纯逻辑，可测） |
| `browser-extension/background/service-worker.js` | 重写 | 两段式授权、改用上面两个模块、生命周期钩子 |
| `browser-extension/content/content-script.js` | 重写 | 内联 `normalizeOrigin`（MV3 不支持 ESM）、`prepare-fill`/`redeem-now` 两段 |
| `browser-extension/popup/popup.js` | 修改 | `fill` → `authorize-fill` + 触发 `redeem-now`；**popup 拿不到密码** |
| `browser-extension/manifest.json` | 修改 | 增加 `webNavigation` 权限（导航失效需要） |
| `browser-extension/tests/auth-store.test.js` | 新增 | 20 项状态机测试 |
| `browser-extension/tests/sender.test.js` | 新增 | 11 项来源分类测试 |
| `browser-extension/tests/origin-parity.test.js` | 新增 | 9 项三实现一致性测试 |
| `rust/keynest-egui/src/bridge/origin.rs` | 修改 | 新增 `matches_js_implementation_on_shared_corpus`（22 条共享语料） |
| `docs/KeyNest-Browser-Bridge-Phase2.2-Report.md` | 新增 | 本报告 |

---

## 3. 授权状态机

```text
        authorize-fill（popup 用户点击）
                 │
                 ▼
            ┌─────────┐
            │ issued  │  有效期 5s
            └────┬────┘
                 │ beginRedeem(校验通过)
                 ▼
          ┌────────────┐
          │ consuming  │  ← 同一 nonce 第二次 beginRedeem 必失败
          └─────┬──────┘
                │ 取密码成功 + 下发
                ▼
            (consumed / 删除)

  任意状态 ── 过期 / tab 关闭 / 主框架导航 / 断连 / SW 重启 ──► 删除
```

**不变式**

1. 只有 `issued` 能被 `beginRedeem`；进入 `consuming` 后不可再兑换 → **重放与并发必然失败**
2. 任何校验失败**立即删除**记录，不留重试机会
3. `state` 只在通过全部校验后推进，不存在"先推进再校验"

### 校验链（`redeemAuth`）

| 顺序 | 检查 | 失败处理 |
| --- | --- | --- |
| 1 | 记录存在 | 返回 null |
| 2 | **重新 `chrome.tabs.get(rec.tabId)` 取浏览器侧 URL** | 删除记录 |
| 3 | 该 URL 规范化后 **=== 记录的 origin** | 删除记录 |
| 4 | 状态为 `issued`（非 consuming） | 删除记录 |
| 5 | 未过期 | 删除记录 |
| 6 | tabId / frameId / origin / entryId 四项全等 | 删除记录 |

第 2–3 步是关键：**绝不用消息里传来的 URL**。

---

## 4. 消息来源分类规则

| 来源 | 判定条件 | 允许的操作 |
| --- | --- | --- |
| **popup / options** | `sender.id === 本扩展` **且** `sender.url` 以 `chrome-extension://<id>/` 开头 **且** 路径 ∈ `['popup/popup.html']` | `query`、`authorize-fill` |
| **content script** | `sender.id === 本扩展` **且** URL 非扩展页面 **且** `sender.tab.id` 为整数 | `redeem-fill`、`content-ready` |
| **网页 / 其它扩展** | 其余一切 | 无 |

**明确不用 `sender.tab` 判特权身份**：`options_ui` 的 `open_in_tab: true` 会让它存在。
测试 `options 在标签页里打开时仍被识别为特权页面` 专门守住这条。

---

## 5. origin 比较实现与测试

三处实现，**同一套语义**：

| 位置 | 文件 | 测试 |
| --- | --- | --- |
| JS（SW / popup） | `lib/origin.js` | `tests/origin.test.js`（12） |
| JS（content script 内联） | `content/content-script.js` | `tests/origin-parity.test.js`（9，**直接读源码取函数**） |
| Rust（GUI 侧二次校验） | `bridge/origin.rs` | 13 项（含 22 条共享语料） |

共享语料覆盖：`example.com` / `example.com.evil.test` / `evil-example.com` / `sub.example.com` /
`http://example.com` / `:8443` / 大小写 / 默认端口 / userinfo / `[::1]` / 无效 URL / 非 HTTP(S)。

**子域不自动授权**：`sub.example.com ≠ example.com`（三处均有断言）。

---

## 6. 一次性授权的创建、验证、消费、失效

| 阶段 | 位置 | 行为 |
| --- | --- | --- |
| **创建** | `handleAuthorize`（popup 触发） | 先 `vault.query` 确认条目属于该 origin，再 `auths.issue()`，把 nonce 交给 content script（**不含密码**） |
| **验证** | `redeemAuth` | 见第 3 节校验链 |
| **消费** | `handleRedeem` 末尾 | 取到密码并回给 content script 后 `auths.consume()` |
| **失效** | `tabs.onRemoved` | `invalidateTab(tabId)` |
| **失效** | `webNavigation.onCommitted`（frameId===0） | `invalidateNavigation(tabId, 0)` |
| **失效** | `port.onDisconnect` | `auths.clear()` |
| **失效** | 过期 | `sweep()` 惰性清理 + 校验时判断 |
| **失效** | SW 重启 | 新执行环境内存为空（并显式 `clear()` 表明意图） |

---

## 7. Service Worker 重启处理

MV3 的 SW 会被浏览器随时终止。重启后是**全新执行环境**，`auths` 内存为空 →
旧 nonce 无法被兑换。代码里显式调用 `auths.clear()` 并附注释，说明这是**有意的**，
不是依赖"恰好内存为空"。

测试 `SW 重启（新实例）不能恢复旧授权` 用两个独立 `AuthStore` 实例模拟这一点。

---

## 8. 自动化测试结果

### 扩展（node --test）

```
tests 52 / pass 52 / fail 0
  ├── origin.test.js          12  PASS
  ├── origin-parity.test.js    9  PASS
  ├── sender.test.js          11  PASS
  └── auth-store.test.js      20  PASS
```

覆盖矩阵：

| 要求 | 测试 | 结果 |
| --- | --- | --- |
| Popup 正常填充授权 | `正常签发 → 兑换 → 消费` | **PASS** |
| Options 页面正常填充授权 | `options 在标签页里打开时仍被识别为特权页面` | **PASS** |
| Content Script 请求 fill 被拒绝 | `content script 即使没有 tab 也不被当作特权页面` + `classifySender` 断言 | **PASS（分类层）** |
| 网页伪造消息被拒绝 | `网页伪造 chrome-extension 前缀被拒绝` | **PASS** |
| 错误扩展 ID 被拒绝 | `错误扩展 ID 被拒绝` | **PASS** |
| 伪造 sender URL 被拒绝 | `伪造的扩展 URL 前缀被拒绝` | **PASS** |
| 导航后旧授权失效 | `主框架导航后授权失效` | **PASS** |
| tab 关闭后旧授权失效 | `tab 关闭后授权失效` | **PASS** |
| frame 不匹配时拒绝 | `frame 不匹配被拒绝` | **PASS** |
| origin 不匹配时拒绝 | `origin 不匹配被拒绝` | **PASS** |
| entry ID 不匹配时拒绝 | `entryId 不匹配被拒绝` | **PASS** |
| 令牌重复使用被拒绝 | `令牌重复使用被拒绝（重放）` | **PASS** |
| 令牌过期被拒绝 | `过期令牌被拒绝` | **PASS** |
| 并发重放被拒绝 | `并发重放只成功一次` | **PASS** |
| SW 重启后旧授权不能恢复 | `SW 重启（新实例）不能恢复旧授权` | **PASS** |
| GUI 锁定后旧授权不能使用 | **见下方说明** | **PASS（部分）** |

> **GUI 锁定后旧授权不能使用**：`port.onDisconnect` → `auths.clear()`，
> 且 `vault.fill` 会被 GUI 门禁拒绝（`VAULT_LOCKED`）。
> 但"锁定但连接未断"这一具体路径**未自动化覆盖**，因为需要真实 GUI 与真实管道 → **NOT TESTED**。

### Rust

```
cargo test --workspace   223 通过
  ├── keynest-core   121 + 2 + 6 + 6
  ├── keynest-bridge  50 + 1
  └── keynest-egui    36 + 1（origin 13 项含跨语言语料）
cargo fmt --all --check  PASS
cargo clippy -D warnings 0 问题
cargo deny check         advisories/bans/licenses/sources 全绿
```

---

## 9. 尚未进行的真实浏览器测试

| 项 | 状态 |
| --- | --- |
| Chrome 加载解包扩展 | **BLOCKED**（需注册表 + 手动加载，本阶段禁止） |
| Edge 同上 | **BLOCKED** |
| 真实 Native Messaging 往返 | **BLOCKED**（需注册 + GUI 解锁） |
| 真实 Named Pipe 往返 | **BLOCKED**（需主密码解锁，不用真实密码） |
| 真实 GUI 锁定/解锁下的授权失效 | **NOT TESTED** |
| 真实 iframe 行为 | **NOT TESTED** |
| 真实页面导航触发 `webNavigation` 事件 | **NOT TESTED** |
| `chrome.tabs.sendMessage` 在 SW 休眠后唤醒 | **NOT TESTED**（MV3 已知易错点） |

**以上全部是"代码正确但没跑过"**。所有 PASS 都是单元/纯逻辑级别。

---

## 10. 密码处理边界（保持原约束）

- 不写入扩展持久化存储（无 `chrome.storage` / `localStorage` / `IndexedDB` 写入）
- 不写入日志（无 `console.log` 输出密码）
- 不使用剪贴板
- **授权 nonce 不交给网页上下文**：popup 拿不到 nonce（由 SW 直接发给 content script），
  网页更拿不到
- `Zeroizing` 只覆盖 Rust 侧内存，**不擦除 JS 字符串**，**不擦除已填入输入框的值**
- 扩展消息授权**不等于**操作系统级进程隔离

新增说明：`confirm` 字段现在传的是**授权 nonce**（32 hex），GUI 侧仍只校验非空与长度，
真正的校验在 SW 的 `redeemAuth`。GUI 侧独立校验解锁状态 + 条目存在 + 未删除 + 精确 origin 未变。

---

## 11. Git 状态

```
分支        feat/browser-bridge
HEAD        （本次提交）
上一提交     f20475b
main        09b870d（未动）
v0.4.3 Tag  2bd390e（未动）
工作区       提交后应为干净
未推送、未合并、未改历史、未写注册表、未加载扩展
```

---

## 12. 仍存风险

| # | 风险 | 等级 | 说明 |
| --- | --- | --- | --- |
| 1 | 从未真实浏览器验证 | **高** | 所有 PASS 为纯逻辑级别 |
| 2 | content script 内联复制 origin 逻辑 | 中 | 已用"直接读源码取函数"的 parity 测试守住；但将来改动仍需同步 |
| 3 | `webNavigation` 增加了一个权限 | 低 | 只用于导航失效；不读取历史内容 |
| 4 | JS 字符串无法擦除 | **无法消除** | MV3 固有 |
| 5 | 密码进入页面 DOM | **无法消除** | 填充语义本身 |
| 6 | SW 休眠唤醒后的时序 | 中 | `sendMessage` 唤醒 SW 的时机未在真实浏览器验证 |
| 7 | 同用户恶意进程 | **无法消除** | 已文档化 |

---

## 13. 结论

**A/B/C 三个缺陷均已修复，且都有对应自动化测试守住。**

但**"代码正确"和"真的能用"是两件事**——Chrome/Edge 的真实链路一次都没跑过。
下一步必须由人工执行注册 + 加载扩展 + 真实冒烟（步骤见阶段 2.1 报告第 5 节）。

**本阶段未写注册表、未加载扩展、未访问真实密码库。等待人工审查。**
