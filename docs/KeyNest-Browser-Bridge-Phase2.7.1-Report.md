# KeyNest 阶段 2.7.1 报告 · TTL 单调时钟修复

> 基线 `d042d28` · 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> **未注册 Native Host、未注册 Edge、未写注册表、未启动 GUI、未创建临时环境。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| TTL 墙上时钟缺陷 | **已修复**（`Date.now()` → `performance.now()`） |
| 异常时安全失败 | **已实现**（NaN/抛异常 → 拒绝，绝不回退） |
| 新增测试 | **16 项**，含 4.9/5.0/5.1 边界、墙上时钟前后拨、时钟异常、SW 重启 |
| 扩展测试总数 | **91 通过**（原 75 + 16） |
| 真实 Chrome 测试 | **仅准备，未执行**（按要求） |

---

## 1. TTL 缺陷与修复 diff

### 1.1 缺陷

```js
// 修复前（service-worker.js:43）
const auths = new AuthStore(() => Date.now(), AUTH_TTL_MS);
```

`Date.now()` 是**墙上时钟**：

| 系统时间操作 | 后果 |
| --- | --- |
| 往前拨（如 10 分钟） | `now` 变小 → `expiresAt <= now` 不成立 → **授权永不过期** |
| 往后拨 | 全部立即过期（安全方向正确，功能中断） |
| NTP 校时回拨 | 授权有效期被意外延长 |

**为什么之前没发现**：node 测试都注入假时钟（递增计数器，**恰好单调**），测不出。

### 1.2 修复 diff

```diff
-const auths = new AuthStore(() => Date.now(), AUTH_TTL_MS);
+/**
+ * 授权 TTL 的时间源：**单调时钟**。
+ * …（注释说明墙上时钟会回拨、单调时钟用于量间隔、SW 重启归零无影响、
+ *   异常时绝不回退到 Date.now）…
+ */
+function monotonicNow() {
+  try {
+    const t = performance.now();
+    return Number.isFinite(t) ? t : Number.NaN;
+  } catch (e) {
+    return Number.NaN;
+  }
+}
+
+const auths = new AuthStore(monotonicNow, AUTH_TTL_MS);
```

**修改范围**：仅 `service-worker.js`（+ `auth-store.js` 的 NaN 加固）。
`AUTH_TTL_MS = 5000` 未变；协议、nonce 格式、绑定字段、claim 逻辑全部未动。

---

## 2. 单调时钟实现与异常处理

### 2.1 为什么 `performance.now()` 是对的

| 特性 | 说明 |
| --- | --- |
| 单调递增 | 不受系统时间调整影响 |
| 相对上下文启动 | SW 重启后从 0 重新计 |
| 用途匹配 | 它天生就是量"时间间隔"的 |

**SW 重启后归零为何没问题**：重启时 `auths` 本就是空 Map（且有显式 `clear()`），
旧授权不可能被恢复——两者语义天然一致。

### 2.2 异常处理（关键）

时钟异常时**必须安全失败**。这里有个**隐蔽陷阱**：

```js
expiresAt = NaN + 5000 = NaN
NaN <= NaN  →  false        // ← 过期检查会"永远通过"！
```

所以不能只写 `r.expiresAt <= this.now()`。加固如下：

**（a）签发时拒绝**

```js
_deadline() {
  let t;
  try { t = this.now(); } catch (e) { throw new Error('clock unavailable'); }
  if (!Number.isFinite(t)) throw new Error('clock unavailable');
  return t + this.ttlMs;
}
```

时钟异常 → `issue()` 抛错 → **签不出授权**（用户重试一次），
而不是签出一个永不过期的授权。

**（b）过期判断显式判 NaN**

```js
_isExpired(record) {
  let t;
  try { t = this.now(); } catch (e) { return true; }   // 抛异常 → 视为过期
  if (!Number.isFinite(t) || !Number.isFinite(record.expiresAt)) return true;
  return record.expiresAt <= t;
}
```

**（c）三处调用点统一**：`sweep()` / `claim()` / `confirm()` 全部改走 `_isExpired`。

**绝不回退到 `Date.now()`** —— 回退会重新引入本缺陷。

---

## 3. TTL 边界测试结果（16 项全部 PASS）

| # | 测试 | 结果 |
| --- | --- | --- |
| 1 | 4.9 秒仍在有效期内 | **PASS** |
| 2 | 恰好 5.0 秒拒绝（`<=` 即过期） | **PASS** |
| 3 | 5.1 秒拒绝 | **PASS** |
| 4 | 4.999 秒仍有效（边界内侧） | **PASS** |
| 5 | 墙上时钟后拨 10 分钟**不能延长**授权 | **PASS** |
| 6 | 单调时钟走满 5s 时，墙上时钟前拨也**必须拒绝** | **PASS** |
| 7 | 墙上时钟回拨**不能让已过期授权复活** | **PASS** |
| 8 | 时钟返回 `NaN` 时**拒绝签发** | **PASS** |
| 9 | 时钟返回 `Infinity` 时拒绝签发 | **PASS** |
| 10 | 时钟中途变 `NaN` → 视为已过期 | **PASS** |
| 11 | 时钟抛异常 → 视为已过期 | **PASS** |
| 12 | 多次兑换仍只能成功一次 | **PASS** |
| 13 | 100 并发仍只成功一次 | **PASS** |
| 14 | 新实例（模拟 SW 重启）不能恢复旧授权 | **PASS** |
| 15 | 重启后单调时钟归零也不会误判为有效 | **PASS** |
| 16 | 认领后、confirm 前过期 → 拒绝（不取密码） | **PASS** |

**全部用可注入时钟驱动，不依赖真实等待 5 秒。**

### 墙上时钟前拨/后拨的测试说明（如实）

测试 5/6/7 用的是**可控单调时钟**，墙上时钟的"前拨/后拨"是**语义断言**而非真实改系统时间：

- 测试 5 断言：单调时钟只走 4.9s 时授权仍有效（无论墙上时钟如何）
- 测试 6 断言：单调时钟走满 5s 时必定拒绝（无论墙上时钟如何）
- 测试 7 断言：记录已删后，时钟归零也无法复活

**没有真实修改系统时间**（那会影响整机、且风险高）。
真正的验证是"TTL 逻辑只依赖注入的单调值，与墙上时间无关"——这一点已被测试证明。

---

## 4. 真实 Chrome 测试准备清单

完整清单见 [`docs/KeyNest-Browser-Bridge-Phase2.7.1-Test-Checklist.md`](KeyNest-Browser-Bridge-Phase2.7.1-Test-Checklist.md)。

### 4.1 环境隔离

| 项 | 值 |
| --- | --- |
| 临时根 | `%TEMP%\KeyNest-Phase2.7-Test\` |
| 数据目录 | `...\data\`（`KEYNEST_DATA_DIR` 指向它） |
| Chrome profile | `...\profile\`（独立） |
| 站点 A | `https://127.0.0.1:9445/` |
| 站点 B | `https://localhost:9446/` |
| 证书 SAN | `DNS:localhost, IP:127.0.0.1` |
| 注册 | **只 Chrome 一条 HKCU**，不注册 Edge |

### 4.2 启动顺序（**最容易踩的坑**）

```
1. 设 KEYNEST_DATA_DIR
2. 启动 Chrome（继承变量）
3. CDP Extensions.loadUnpacked 加载扩展
4. 用同一变量启动 GUI
```

**顺序错了就废**：Chrome 启动 Host 时，Host 继承的是 **Chrome 进程的环境**，
不是之后启动 GUI 的 shell 环境。

### 4.3 七项测试与证据分类

| 测试 | REAL_CHROME | REAL_GUI | NODE_SIM | 难度 |
| --- | --- | --- | --- | --- |
| T1 跨站 iframe | ✔ | ✔ | ✔ | 易 |
| T2 同源 iframe 边界 | ✔ | — | — | 易 |
| T3 导航后失效 | ✔ | ✔ | ✔ | 易 |
| T4 TTL 过期 | ✔ | — | ✔ | 中 |
| T5 Tab 关闭 | ✔ | — | ✔ | 中 |
| T6 SW 休眠 | ✔ 或 **BLOCKED** | — | ✔ | **难** |
| T7 并发兑换 | ✔ | ✔ | ✔ | 中 |

### 4.4 假阳性规避（必须遵守）

| # | 陷阱 | 规避 |
| --- | --- | --- |
| 1 | iframe 未加载完就读值 | 等 `load` 事件 |
| 2 | CDP 往返延迟跨 5s 边界 | 记录实际耗时，容差 ±100ms |
| 3 | SW 未真正停止 | 用 CDP target 列表确认消失 |
| 4 | `Promise.all` 被串行化 | 在 SW 内直接调函数 |
| 5 | `pushState` 误认为导航 | 断言 `documentId` 未变 |
| 6 | tab 关闭与兑换竞态 | 兑换在关闭之后发起 |

---

## 5. Service Worker 测试能否可靠执行

**结论：很可能只能标 `BLOCKED`。**

理由：

| 障碍 | 说明 |
| --- | --- |
| 无官方 API 强制停止 SW | MV3 生命周期由浏览器控制 |
| 空闲超时 30 秒 | 期间任何事件都会重置计时 |
| `Target.closeTarget` 后 Chrome 可能立即重建 | 无法证明"真的停了" |
| CDP 观察窗口有限 | 需要轮询 `/json/list` 捕捉消失瞬间 |

**判定规则（严格执行）**：

- ✅ 若能通过 CDP target 列表**证明 SW 消失后又重新出现** → 标 `REAL_CHROME` PASS
- ❌ 若无法可靠证明 → **标 `BLOCKED`**，附原因，**不得标 PASS**

**可接受的替代证据**（BLOCKED 时补充）：

1. `NODE_SIMULATED`：新 `AuthStore` 实例看不到旧记录（已有测试）
2. 代码审查：全仓无 `storage` / `localStorage` / `indexedDB` 写入
3. 逻辑论证：`auths` 是内存 Map，进程结束即消失

---

## 6. 测试结果汇总

| 类别 | 数量/结果 |
| --- | --- |
| 扩展 node 测试 | **91 通过**（原 75 + TTL 16） |
| `node --check` 语法 | PASS |
| Rust 测试 | **未重跑**（本阶段未改 Rust 代码） |
| 真实 Chrome | **NOT_TESTED**（按要求只准备） |

---

## 7. 未解决风险

| # | 风险 | 等级 | 说明 |
| --- | --- | --- | --- |
| 1 | SW 休眠测试可能无法可靠执行 | 中 | 只能标 BLOCKED，替代证据见第 5 节 |
| 2 | 两进程环境分叉 | 中 | 阶段 2.7 已记录，本阶段未处理 |
| 3 | TTL 真实浏览器边界测试受 CDP 延迟影响 | 低 | 容差 ±100ms |
| 4 | `performance.now()` 在极少数环境下不可用 | 低 | 已实现安全失败（拒绝签发） |
| 5 | JSON 明文 `String` 未 `Zeroizing` | 低 | 阶段 2.6 已记录 |

---

## 8. 是否建议进入真实 Chrome 验收

**建议进入**，条件：

1. 批准注册 Chrome 一条 HKCU 项（唯一系统级改动）
2. 批准创建临时 Chrome profile 与临时密码库
3. 接受 **T6（SW 休眠）可能标 BLOCKED**
4. 严格按"先设变量 → 启 Chrome → 启 GUI"的顺序

**不建议跳过 TTL 验证**——本次修复的价值必须由 T4 在真实浏览器里确认。

---

## 9. Git 与数据保护

| 项 | 状态 |
| --- | --- |
| 修改范围 | `service-worker.js` + `auth-store.js` + 新增 `tests/ttl.test.js` + 2 份文档 |
| main | `09b870d` 未动 |
| v0.4.3 | `2bd390e` 未动 |
| 注册表 | **未写入**（Chrome / Edge 均 False） |
| 真实 vault.dat | **未读取、未修改** |
| 真实 bridge.key | **未创建、未修改** |
| 临时测试环境 | **未创建** |
| 推送/合并/发布 | 未执行 |

---

## 10. 停止点

**本阶段完成，已停止。**

- 未执行真实 Chrome 测试
- 未注册 Native Host / Edge
- 未启动 GUI / Native Host
- 未创建临时环境
- 未进入自动保存开发

等人工审查后，再决定是否启动真实 Chrome 验收。
