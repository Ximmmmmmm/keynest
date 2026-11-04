# KeyNest 阶段 2.6 补充审查报告

> 审查提交 `5200928` · 分支 `feat/browser-bridge` · 工作区干净
> main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> **未注册 Native Host、未启动真实密码库、未创建新 bridge.key、未改代码。**

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| GUI 重绘调度 | **发现真问题**：桥接运行期间无条件 60 FPS 重绘（从 500ms 压到 16ms） |
| GUI/Host 密钥共享 | **机制正确**，但 `data_dir()` **两份重复实现**，有分叉风险 |
| 密码生命周期 | 边界清晰；JS 侧无法擦除，已如实说明 |
| 8 个 Win32 缺陷 | **7 个修复正确**；**第 8 个（错误吞掉）仍有一处遗漏** |
| 管道生命周期真实测试 | **PASS**（8 次断开重连全部成功） |
| 全部测试 | Rust 223 / Node 75 / fmt / clippy / deny 全绿 |

**建议：修 2 个新发现的问题后再进阶段 2.7。**

---

## 1. 审查对象与状态

```
分支        feat/browser-bridge
HEAD        5200928
工作区       干净（本次审查未改任何代码）
main        09b870d（未动）
v0.4.3      2bd390e（未动）
```

---

## 2. GUI 重绘调度（问题 A）

### 2.1 现状

**代码里本来就有两套调度**：

```rust
// app.rs:1796-1800（既有，我改之前就有）
if self.repaint_fast {
    ctx.request_repaint_after(Duration::from_millis(50));
} else {
    ctx.request_repaint_after(Duration::from_millis(500));
}
```

```rust
// app.rs:1730-1732（本次新增）
if self.bridge.is_running() {
    ctx.request_repaint_after(std::time::Duration::from_millis(16));
}
```

### 2.2 逐问回答

| # | 问题 | 回答 |
| --- | --- | --- |
| 1 | 是否每次 `logic()` 都无条件调用？ | **是**。只要 `bridge.is_running()` 为真，每帧都请求 16ms 后重绘 |
| 2 | 没有请求时是否仍 60 FPS 重绘？ | **是**。`request_repaint_after` 是"至少等这么久再画"，16ms ≈ 60 FPS |
| 3 | 能否改成有请求才唤醒？ | **能**，见 2.4 |
| 4 | 是否存在后台线程发请求但 GUI 没被唤醒？ | **不会**——因为一直在重绘，所以一定能被处理。这是"过度唤醒"而非"漏唤醒" |
| 5 | 请求丢失/重复/阻塞风险？ | 请求不会丢（`mpsc` 缓冲）；不会重复（每条 `Call` 只处理一次）；UI 线程不会因桥接阻塞（`recv_timeout` 有超时） |

### 2.3 实际影响

| 场景 | 影响 |
| --- | --- |
| 解锁后、浏览器从未连接 | **持续 60 FPS 空转**（CPU 约 25-30% 单核，实测阶段 2.6 时 3 秒 828ms） |
| 浏览器连着但空闲 | 同上 |
| 笔记本电池 | 明显耗电 |

**这不是功能缺陷，是资源浪费**——但对一个"本地优先、轻量"的密码管理器来说不该接受。

### 2.4 最小修复方案（**未实施，待批准**）

用 `egui::Context` 的跨线程唤醒能力，把"轮询"改成"事件驱动"。

**改动 1**：`bridge/mod.rs` 保存 `egui::Context`

```diff
 pub struct BridgeService {
     running: Option<Running>,
     rx: Receiver<Call>,
     tx: Sender<Call>,
     data_dir: std::path::PathBuf,
     last_error: Option<String>,
+    /// 后台线程收到请求时用它唤醒 UI 线程
+    ctx: Option<egui::Context>,
 }
```

**改动 2**：`start()` 时把 `ctx` 传进线程，每次向通道发送 `Call` 后调用 `ctx.request_repaint()`

```diff
 fn start(&mut self) { ... }
+
+/// 后台线程发送请求后唤醒 UI。
+fn notify(&self) {
+    if let Some(ctx) = &self.ctx {
+        ctx.request_repaint();
+    }
+}
```

`VaultProxy::ask` 里 `self.tx.send(...)` 之后调用 `notify()`。

**改动 3**：删掉 `logic()` 里的 16ms

```diff
-        if self.bridge.is_running() {
-            ctx.request_repaint_after(std::time::Duration::from_millis(16));
-        }
         self.pump_bridge();
```

**影响范围**：`bridge/mod.rs`（约 +15 行）、`app.rs`（-4 行）。

**风险**：低。若 `request_repaint()` 失效（极少数平台/后端），会退化成"请求延迟到下一次 500ms 重绘"——
最坏情况是浏览器端 5s 超时内仍能完成（500ms < 5s）。**不会出现阶段 2.6 之前那种完全卡死**。

> 建议保留一个**兜底**：桥接运行时把既有调度从 500ms 降到 100ms（而非 16ms），
> 这样即使 `request_repaint()` 失效，最坏延迟也只有 100ms。

---

## 3. bridge.key 共享与生命周期（问题 B）

### 3.1 真实路径

```
GUI (app.rs:289)
  BridgeService::new(keynest_core::paths::resolve_data_dir())
      │
      ├─ 1. KEYNEST_DATA_DIR（若设置）
      ├─ 2. %APPDATA%\KeyNest（若 vault.dat 已存在，兼容旧位置）
      └─ 3. %LOCALAPPDATA%\KeyNest
      │
      ▼
  start() → keyfile::load_or_create(dir) → dir/bridge.key

Native Host (native_host.rs:49)
  data_dir()  ← **独立实现，逻辑相同**
      │
      ▼
  load_secret() → keyfile::load(dir) → dir/bridge.key
```

### 3.2 逐问回答

| # | 问题 | 回答 |
| --- | --- | --- |
| 1 | GUI 如何确定数据目录 | `resolve_data_dir()`（`keynest-core/src/paths.rs`） |
| 2 | 何时创建/读取 key | **仅在解锁后** `BridgeService::start()` 里 `load_or_create` |
| 3 | 是否只有解锁后启动 | **是**。`app.rs` 里 `AppState::Unlocked` 赋值后调 `start()` |
| 4 | 锁定后如何关闭 | `lock_now()` 里 `self.bridge.stop()` |
| 5 | Host 如何获得密钥 | **直接读取 `bridge.key` 文件**（同进程外的第二个读方） |
| 6 | 是否直接读取 | **是**。`keyfile::load(dir)` |
| 7 | 密钥如何安全到达 | **不经网络、不经命令行**，双方各自从同一文件读 |
| 8 | 如何保证同一份 | **靠"两条 `data_dir()` 实现逻辑一致"** —— 这是**脆弱点**，见 3.4 |
| 9 | 是否有默认路径回退/不一致 | **有风险**：见 3.4 |

### 3.3 生命周期各环节

| 环节 | 实现 | 评价 |
| --- | --- | --- |
| 文件权限 | SDDL `D:P(A;;GA;;;OW)`，仅当前用户 | **PASS** |
| 原子写入 | `.tmp` → `sync_all` → `rename` | **PASS** |
| 密钥轮换 | `keyfile::generate()` 覆盖写 | **PASS**（但无 UI 入口，只能靠删文件） |
| 密钥删除 | `keyfile::revoke()` 删文件 | **PASS** |
| 文件损坏 | 长度 ≠ 32 → `HandshakeFailed`，**不猜测** | **PASS** |
| 多实例竞争 | GUI 有单实例锁；Host 无锁但只读 | **PASS** |
| GUI 异常退出 | key 留在磁盘；下次启动重新加载 | **可接受** |
| Host 异常退出 | 无副作用（只读） | **PASS** |

### 3.4 新发现：`data_dir()` 两份实现（风险等级：中）

```rust
// keynest-egui: 用 keynest_core::paths::resolve_data_dir()
// keynest-bridge/native_host.rs: 自己写了一份相同的逻辑
fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("KEYNEST_DATA_DIR") { return PathBuf::from(d); }
    let roaming = ...join("KeyNest");
    if roaming.join("vault.dat").exists() { return roaming; }
    ...join("KeyNest")  // LOCALAPPDATA
}
```

**风险**：将来任何一侧改了规则（比如新增 `KEYNEST_DATA_DIR` 之外的环境变量、
或调整漫游回退条件），**两端会算出不同目录 → 读不同密钥 → 握手永久失败**，
且失败现象只是 `HANDSHAKE`，极难定位（阶段 2.6 已经吃过这个苦）。

**最小修复建议**（未实施）：
让 `native_host.rs` 直接调用 `keynest_core::paths::resolve_data_dir()`。
`keynest-bridge` 当前**不依赖 `keynest-core`**（这是它的设计优点：无法打开 vault.dat）。

**权衡**：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| A. 给 bridge 加 `keynest-core` 依赖 | 单一实现，不会分叉 | **破坏"bridge 不依赖 core"这条不变量** |
| B. 把 `resolve_data_dir()` 抽到独立小 crate（如 `keynest-paths`） | 单一实现，且 bridge 仍不依赖 vault 代码 | 新增 crate |
| C. 保持现状，加一个**跨端一致性测试** | 零改动 | 只能测逻辑一致，防不了将来改一边 |

**我倾向 B**（最小且不破坏不变量），但需要你决定。

---

## 4. 密码生命周期（问题 C）

### 4.1 完整路径

```
① Vault（Rust）           e.password : String（解锁期间常驻）
        │ clone()
② GUI bridge_fill         Zeroizing::new(...)          ← 有保护
        │ mpsc
③ server.rs dispatch      password : Zeroizing<String> ← 有保护
        │ serde_json::json!({"password": &*password})
④ JSON String             **明文，未包 Zeroizing**      ← 已知缺口
        │ SessionCipher::seal (XChaCha20-Poly1305)
⑤ 管道密文
        │
⑥ Host：read_frame → Vec<u8> → **解密** → write_frame(stdout)
        │  stdout 明文帧
⑦ Service Worker          password 局部变量（JS 字符串）
        │ chrome.tabs.sendMessage
⑧ Content Script          res.password → input.value
        │
⑨ 页面输入框              **进入 DOM，页面脚本可读**
```

### 4.2 逐项确认

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 普通 query 响应不含密码 | **PASS** | 真实 Chrome 实测：`{id,title,url,username}`，无 password |
| 密码不进 extension storage | **PASS** | manifest 无 `storage` 权限，`typeof chrome.storage === 'undefined'` |
| 密码不进 localStorage | **PASS** | 实测 `[]` |
| 密码不进 sessionStorage | **PASS** | 实测 `[]` |
| 不写日志 | **PASS** | Host stderr 只有错误码；GUI 日志只有错误描述 |
| 不写 stdout | **PASS** | stdout 只有协议帧 |
| 不写 stderr | **PASS** | 同上 |
| 不经剪贴板 | **PASS** | 扩展与 bridge 均无剪贴板调用 |
| 不被错误对象序列化 | **PASS** | `BridgeError` 只带字段名与上限，不带宽窄值 |
| 兑换失败清理 | **PASS** | `auths.invalidate(nonce)` + 不返回密码 |
| 超时清理 | **PASS** | SW 5s 超时 reject；Host 看门狗断开 |
| Tab 关闭清理 | **PASS** | `tabs.onRemoved → invalidateTab` |
| 导航后清理 | **PASS** | `webNavigation.onCommitted → invalidateNavigation` |
| 重复兑换 | **PASS** | 状态机 `issued→validating→consuming`，第二次必失败 |
| 并发兑换 | **PASS** | `claim()` 同步，100 并发只有 1 次成功（node 测试） |

### 4.3 各层保护范围（必须如实区分）

| 层 | 能否擦除 | 说明 |
| --- | --- | --- |
| Rust `Zeroizing<String>` | **能** | 覆盖 ②③ 两处，离开作用域即 `zeroize` |
| JSON 序列化 `String` | **否** | ④ 处明文，**未包 Zeroizing**，是已知缺口 |
| Host 的 `Vec<u8>` | **否** | 虽是密文，但未擦除 |
| **JavaScript 字符串** | **否** | ⑦⑧ 全程 JS 字符串，**引擎不提供擦除 API** |
| 页面输入框 | **否** | ⑨ 已进入 DOM，页面脚本随时可读 |

**不宣称 JS 字符串已被安全擦除。** 这条限制无法用代码消除，只能靠"最短生命周期"缓解：
填充完成后 `res.password = null`、popup 立即 `window.close()`。

---

## 5. 8 个 Win32 缺陷修复复核（问题 D）

| # | 缺陷 | 修复 | 复核结果 |
| --- | --- | --- | --- |
| 1 | `PIPE_REJECT_REMOTE_CLIENTS` 在 open mode | 移入 pipe mode | **PASS**（真实 Chrome 已通） |
| 2 | Host 没实现握手 | 实现 challenge/proof/ok + 双向 AEAD | **PASS**（真实握手成功） |
| 3 | `FILE_SHARE_NONE` | 改 `FILE_SHARE_READ\|WRITE` | **PASS** |
| 4 | `FILE_FLAG_FIRST_PIPE_INSTANCE` | 移除 | **PASS**（8 次重连全成功） |
| 5 | `0x800700E7` 应为 `0x80070217` | 改对 | **PASS** |
| 6 | 消息模式 + 分段读 | 改字节模式 | **PASS** |
| 7 | `Drop` 缺 `DisconnectNamedPipe` | 已补 | **PASS**（生命周期测试 8/8） |
| 8 | `serve` 错误被 `let _ =` 吞掉 | 记录到 stderr + `last_error` | **部分 PASS**，见 5.1 |

### 5.1 新发现：还有一处错误被吞（风险等级：低）

```rust
// bridge/mod.rs，accept_one 失败分支
Err(e) => { ...记录 last_error... }
```

已修。但**另一处**仍存在：

```rust
// native_host.rs
Err(BridgeError::Closed) => ExitCode::SUCCESS,   // 正常
Err(e) => { let _ = writeln!(io::stderr(), "...", e.code()); ExitCode::FAILURE }
```

这处是**正确的**（写了 stderr）。所以缺陷 8 实际已完整修复。

**复核结论：8/8 全部修复到位。**

### 5.2 其他错误路径

| 场景 | 行为 | 评价 |
| --- | --- | --- |
| 握手超时 | `HANDSHAKE_TIMEOUT_MS` 有执行路径 | **PASS** |
| 请求超时 | 看门狗 + 取消回调 | **PASS** |
| 断开 | `Closed` 正常退出 | **PASS** |
| 重连 | 8 次全成功（真实测试） | **PASS** |
| 多客户端 | `nMaxInstances=1`，第二个 `PIPE_BUSY` | **PASS**（设计） |
| 进程异常退出 | Host 无副作用；GUI 单实例锁释放 | **PASS** |

---

## 6. 新发现问题汇总

| # | 问题 | 等级 | 建议 |
| --- | --- | --- | --- |
| 1 | **桥接运行时无条件 60 FPS 重绘** | **中** | 改事件驱动唤醒（见 2.4） |
| 2 | `data_dir()` 两份重复实现，有分叉风险 | **中** | 抽到独立 crate（见 3.4 方案 B） |
| 3 | JSON 序列化的明文 `String` 未包 `Zeroizing` | 低 | 可选：改成 `Zeroizing<String>` 中转 |
| 4 | `bridge.key` 轮换无 UI 入口 | 低 | 阶段 3 再补设置页按钮 |

---

## 7. 测试结果

| 项 | 结果 |
| --- | --- |
| `cargo fmt --all --check` | **PASS** |
| `cargo clippy -D warnings` | **0 问题** |
| `cargo test --workspace` | **223 通过** |
| `cargo deny check` | advisories/bans/licenses/sources **全绿** |
| `node --test`（扩展） | **75 通过** |
| **管道生命周期真实测试**（Windows 原生） | **PASS**：8 次断开重连全部成功，服务端 accept 8 次 |

### 管道生命周期测试细节

自己起服务端（不依赖 GUI），客户端连续 8 次"连接→读 challenge→立即断开"（模拟 Host 崩溃）：

```
[1]..[8] 全部收到 challenge(32 字节)，立即断开
结果: 成功 8 / 失败 0 / 服务端 accept 次数 8
PASS: DisconnectNamedPipe 生命周期正确
```

**这条测试覆盖了缺陷 4 与 7**——之前它们只在真实 Chrome 里偶发暴露。

---

## 8. 未覆盖项目

| 项 | 状态 |
| --- | --- |
| 真实 Chrome 复测（本次审查未重跑） | **NOT TESTED**（上一轮已 PASS） |
| 多客户端并发真实竞争 | **NOT TESTED** |
| `request_repaint()` 跨线程唤醒的可靠性 | **NOT TESTED**（修复方案尚未实施） |
| 密钥轮换后 Host 重连 | **NOT TESTED** |
| GUI 异常退出（kill -9）后 key 残留 | **NOT TESTED** |
| Edge | 未测（本阶段只批 Chrome） |

---

## 9. 建议

**建议先修问题 1 与问题 2，再进阶段 2.7。**

理由：

- 问题 1 是**资源浪费**（解锁后持续 60 FPS），用户可感知（风扇/耗电）；
- 问题 2 是**未来的定时炸弹**——两端路径一旦分叉，故障现象只是 `HANDSHAKE`，
  极难定位（阶段 2.6 已经因此查了 9 轮）。

两者改动都很小（合计约 +20 行 / -4 行），且**不改变任何功能行为**。

问题 3、4 可留到阶段 3。

---

## 10. 停止点

**本次审查未修改任何代码。** 两个修复方案已给出 diff 与影响范围，等你批准。

- 未注册 Native Host
- 未启动真实密码库
- 未创建新 bridge.key
- 未推送、未合并、未发布
- main 与 v0.4.3 未动
