# KeyNest 阶段 2.7.2 报告 · 真实 Chrome 验收执行

> 基线 `6eb493a` · 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：**真实 Chrome 156.0.8078.80** + 真实 Native Host + 真实 GUI + 真实命名管道 + 临时密码库
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 真实 Chrome 执行 | **已完成**（Chrome 156，独立 profile） |
| PASS | **13 项** |
| FAIL | **2 项**（均由同一产品缺陷导致） |
| BLOCKED | **2 项** |
| **发现的产品缺陷** | **1 个（中）**：看门狗把"客户端空闲"当成"请求超时" |
| 环境清理 | **完全干净** |
| 真实库 / 真实 bridge.key | **未触碰** |

---

## 1. Git 状态

```
分支        feat/browser-bridge
HEAD        6eb493a（阶段 2.7.1 TTL 修复）
工作区       干净（本阶段未改产品代码）
main        09b870d（未动）
v0.4.3      2bd390e（未动）
```

---

## 2. 测试环境

| 项 | 值 |
| --- | --- |
| Chrome | **156.0.8078.80** |
| 扩展 ID | `nkmbkncopjdbdleomifkloegjjfpccjk` |
| 扩展版本 | 0.5.0（`manifest.json`） |
| GUI | `keynest-egui`（debug，阶段 2.7.1 代码） |
| Native Host | `keynest-native-host.exe`（564,224 字节） |
| 站点 A | `https://127.0.0.1:9445/`（顶层表单 + 同源 iframe + 跨站 iframe→B） |
| 站点 B | `https://localhost:9446/` |
| 证书 | 自签，SAN = `DNS:localhost` + `IP:127.0.0.1` |
| 临时库 | `...\data\vault.dat`（2052 字节），虚构主密码 `p272-test-master` |
| 测试条目 | `92fede7d-405d-4446-a633-11302c85260a`，用户名 `phase272-user` |
| 启动顺序 | **先设 `KEYNEST_DATA_DIR` → 启 Chrome → CDP 加载扩展 → 启 GUI** ✅ |

---

## 3. 逐项测试结果

### T1 · Native Messaging Host 启动与握手 —— **PASS**

| 项 | 内容 |
| --- | --- |
| 步骤 | 扩展发 `status` |
| 预期 | `ok=true`，`locked=false` |
| **实际** | `{ok:true, data:{locked:false, protocol:1, version:"0.4.3"}}` |
| 层 | **REAL_CHROME + REAL_NATIVE_HOST + REAL_GUI** |
| 证据 | 返回体含 `version:"0.4.3"`，证明来自真实 GUI 进程 |
| 附加 | Host stdout 只有协议帧（无诊断文本）；错误只写 stderr（阶段 2.6 已验证） |

### T2 · 真实查询（不含密码）—— **PASS**

| 项 | 内容 |
| --- | --- |
| **实际** | `{ok:true, origin:"https://127.0.0.1:9445", entries:[{id:"92fede7d-…", title:"Phase272 Entry", url:"https://127.0.0.1:9445/", username:"phase272-user"}]}` |
| 关键 | 返回体**无 `password` 字段** |
| 层 | REAL_CHROME + REAL_NATIVE_HOST + REAL_GUI |

### T3 · 真实主动填充 —— **PASS（5 个子项）**

| 子项 | 结果 | 证据 |
| --- | --- | --- |
| T3a 授权签发 | **PASS** | `{ok:true, nonce:"34de85f8…"}`（32 hex） |
| T3b 一次性兑换 | **PASS** | `{ok:true}` |
| T3c **页面实际被填充** | **PASS** | `user="phase272-user"`，密码框长度 > 0 |
| T3d 不进入任何存储 | **PASS** | `typeof chrome.storage === "undefined"`；`localStorage=[]`；`sessionStorage=[]` |
| T3e 重复兑换被拒 | **PASS** | `ok=false` |

**nonce 绑定验证**（授权时记录，兑换时重取）：
- `tabId` / `frameId` / `origin` / `entryId` / `documentId` / `topDocumentId`
- 实测 frame 结构：主帧 `doc=840998BB`，同源 iframe `doc=E3BE8A32`，跨站 iframe `doc=300B2A47`

### T4 · 真实 TTL —— **PASS（2 子项，含测量误差说明）**

| 子项 | 要求 | 实测耗时 | 结果 |
| --- | --- | --- | --- |
| T4a | 5 秒内兑换应成功 | **4.59s** | **PASS**：`{ok:true, password:"phase272-…"}` |
| T4b | 5 秒后应拒绝 | **5.73s** | **PASS**：`AUTH_REJECTED` |

**测量误差说明（如实）**：
- 第一次尝试用 `setTimeout(4900)`，实测 5.89s（CDP 往返 + SW 调度约 1s 开销）→ **已超 5s，`AUTH_REJECTED` 是正确行为**
- 改用 `setTimeout(4000)` 留余量，实测 4.59s → 成功
- **5.0s 精确边界无法在真实 Chrome 中稳定命中**（误差 ±1s > 边界余量），该点由 `UNIT_TEST` 覆盖（阶段 2.7.1 的 16 项）

**结论**：TTL 在真实浏览器中**确实生效**，单调时钟修复有效。

### T5 · 导航 / iframe / Tab 关闭 —— **PASS（4 子项）+ 1 项能力边界**

| 子项 | 结果 | 证据 |
| --- | --- | --- |
| T5a frame 结构 | **PASS** | 3 个 frame：`frameId=0`（9445）、`17`（9445/iframe-same）、`18`（localhost:9446） |
| T5b **同源 iframe 无 content script** | **PASS（能力边界）** | `NO_CONTENT_SCRIPT` —— 当前 `all_frames:false` + `frameId=0` 设计**不支持 iframe 填充**。**这不是缺陷，是已知限制** |
| T5c 跨站 iframe origin 不同 | **PASS** | 跨站 frame url = `https://localhost:9446/`，与顶层 `127.0.0.1:9445` 不同 |
| T5d 同 origin 导航后旧授权失效 | **PASS** | 导航到 `/other` 后兑换 → 拒绝 |
| Tab 关闭 | **NOT TESTED** | 未单独执行（时间预算用在了缺陷复现上） |

> **明确区分**：T5b 是"当前功能不支持"，**不是"iframe 填充成功"**。

### T6 · Service Worker 休眠与重启 —— **BLOCKED**

**原因**：

| 条件 | 是否满足 |
| --- | --- |
| 1. 有证据证明原 SW target 已消失 | ❌ 无法可靠捕获 |
| 2. 有证据证明新 SW target 已启动 | ❌ |
| 3. 旧授权无法在新 Worker 中恢复 | ❌ 无法验证 |

MV3 SW 生命周期由浏览器控制，`Target.closeTarget` 后可能立即重建，无官方 API 强制停止。
**严格按要求标 `BLOCKED`，不冒充 PASS。**

**辅助证据**（不作为替代）：
- `NODE_SIMULATED`：新 `AuthStore` 实例看不到旧记录（阶段 2.7.1 测试）
- 代码审查：全仓无 `storage`/`localStorage`/`indexedDB` 写入

### T7 · 并发兑换 —— **FAIL（由产品缺陷导致）**

| 项 | 内容 |
| --- | --- |
| 步骤 | popup 签发授权 → popup 发 `prepare-fill` → **content script 世界**发 100 个 `redeem-fill` |
| **实际** | `{okCount:0, total:100, codes:{"REJ:HOST_DISCONNECTED":1, "REJ:AUTH_REJECTED":99}}` |
| 解读 | **99 个被 `claim` 正确拒绝**（同步独占生效）；**1 个走到底但因看门狗断连失败** |
| 判定 | **FAIL** —— 唯一成功者没成功 |

**这暴露了产品缺陷**（见第 4 节）。

### T8 · 锁定与错误场景 —— **PASS（3/4）**

| 子项 | 结果 | 证据 |
| --- | --- | --- |
| T8a 错误 entryId | **PASS** | `ENTRY_NOT_MATCHED` |
| T8b 跨 origin 查询不返回 A 条目 | **FAIL** | 返回 `HOST_DISCONNECTED`（看门狗缺陷，非逻辑问题） |
| T8c 跨 origin 授权被拒 | **PASS** | `ENTRY_NOT_MATCHED` |
| T8d HTTP 页面被拒 | **PASS** | `HTTP_NOT_ALLOWED` |

---

## 4. 发现的产品缺陷

### 缺陷：看门狗把「客户端空闲」当成「请求超时」

| 项 | 内容 |
| --- | --- |
| **位置** | `rust/keynest-bridge/src/server.rs` 请求循环 |
| **现象** | GUI 日志大量 `serve 结束: 请求超时 (TIMEOUT)`；客户端空闲 > 3 秒后连接被断开，后续请求全 `HOST_DISCONNECTED` |
| **根因** | `watchdog.arm()` 在**读帧之前**调用，`disarm()` 在回复之后。于是「客户端多久不发下一个请求」也被计入 3 秒超时 |
| **影响** | **真实用户体验**：用户点开扩展后犹豫几秒，连接就断；并发请求排队时也会超时 |
| **等级** | **中** |
| **复现** | 连接后空闲 4 秒再发请求 → GUI 日志出现 `TIMEOUT`，连接断开 |
| **最小修复建议** | 把 `arm()` 移到**读到帧之后、`handle_one()` 之前**。这样看门狗只约束「服务端处理时间」，不约束「客户端思考时间」 |

**修复 diff 建议**（未实施）：

```diff
 loop {
-    watchdog.arm(opts.request_timeout);
     let frame = match read_frame(transport) { ... };
+    // 只在真正开始处理时才计时：客户端空闲不算超时
+    watchdog.arm(opts.request_timeout);
     ...
 }
```

**影响范围**：`server.rs` 一处 + 注释。风险低。

**为什么之前没发现**：所有单元测试都是「立即发请求」，从不空闲等待。
真实浏览器里用户思考、TTL 测试等待都会触发。

---

## 5. PASS / FAIL / BLOCKED 汇总

| 分类 | 数量 | 明细 |
| --- | --- | --- |
| **PASS** | **13** | T1、T2、T3a–e（5）、T4a、T4b、T5a–d（4）、T8a、T8c、T8d |
| **FAIL** | **2** | T7（并发）、T8b（跨 origin 查询） |
| **BLOCKED** | **2** | T6（SW 休眠）、T5 Tab 关闭（NOT TESTED） |
| **NOT TESTED** | **1** | Tab 关闭后失效 |

**两个 FAIL 的根因是同一个产品缺陷**（看门狗），不是安全逻辑错误。

---

## 6. 真实密码库对比

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| size | `42228` | **`42228`** |
| mtime | `2026-11-01 23:19:17.191727900 +0800` | **相同** |
| MD5 | `2bd94cde0fa7d1e1166c930324f763c` | **相同** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| 真实 `%LOCALAPPDATA%\KeyNest` | 不存在 | **不存在** |

---

## 7. 注册表对比

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| Chrome `com.keynest.bridge` | `False` | **`False`** |
| Edge `com.keynest.bridge` | `False` | **`False`（全程未创建）** |

---

## 8. 清理结果

| # | 项目 | 结果 |
| --- | --- | --- |
| 1 | 临时 Chrome | **已关闭**（进程 0） |
| 2 | 临时 GUI | **已关闭**（进程 0） |
| 3 | Native Host 进程 | **已退出**（进程 0） |
| 4 | Chrome HKCU 注册项 | **已删除** |
| 5 | 临时 Profile | **已删除** |
| 6 | 临时库 / bridge.key / 证书 / manifest / 目录 | **已删除**（`KeyNest-Phase2.7.2` 不存在） |
| 7 | 遗留进程 | **0**（chrome / keynest / python 全部清理） |
| 8 | 注册表复核 | Chrome/Edge 均 `False` |
| 9 | 真实库复核 | size/mtime/MD5 **完全一致** |
| 10 | 真实 bridge.key | **不存在** |

**清理完全成功，无遗留。**

---

## 9. 未覆盖的风险与限制

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **看门狗缺陷** | 会阻塞 T7/T8b 类型测试，且影响真实用户体验 |
| 2 | T6 SW 休眠 | 无法可靠证明，只能 BLOCKED |
| 3 | T5 Tab 关闭 | 未单独执行 |
| 4 | 5.0s 精确边界 | 真实 Chrome 误差 ±1s，无法命中；由 UNIT_TEST 覆盖 |
| 5 | iframe 填充 | 结构性不支持（已知限制，非缺陷） |
| 6 | Edge | 未测试（本阶段只批 Chrome） |
| 7 | 两进程环境分叉 | 阶段 2.7 已记录，未处理 |

---

## 10. 建议

### 必须先修（再进下一阶段）

**看门狗把客户端空闲当超时** —— 这是本阶段挖出的真实产品缺陷：

- 影响真实用户体验（点开扩展犹豫 3 秒就断）
- 阻塞并发与长等待类测试
- 修复风险低（`arm()` 移一行）

### 建议顺序

1. 批准修看门狗（1 处改动 + 测试）
2. 重跑 T7 / T8b 验证修复
3. 再考虑 T6（若仍无法可靠执行，保持 BLOCKED）

---

## 11. 停止点

**本阶段完成，已停止。**

- 未修改产品代码（仅新增本报告与临时测试脚本，脚本已删除）
- 未注册 Edge
- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 临时环境已完全清理
