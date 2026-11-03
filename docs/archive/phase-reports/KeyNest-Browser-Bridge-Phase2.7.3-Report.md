# KeyNest 阶段 2.7.3 报告 · 看门狗生命周期修复

> 基线 `a7a991d` · 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> **未启动真实 Chrome、未注册 Host、未启动 GUI、未触碰真实库或 bridge.key。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 缺陷根因 | 已定位：`watchdog.arm()` 在读帧**之前**，把客户端空闲算进请求超时 |
| 修复 | 三阶段拆分：空闲不 arm / 首字节到达 arm / 处理完 disarm |
| **核心验收** | **PASS**：真实 Windows 命名管道空闲 **5 秒**后通信正常 |
| 测试 | Rust **241** 通过（新增 7 项）、Node 91、fmt/clippy/deny 全绿 |

---

## 1. 缺陷根因

### 1.1 修复前的调用链

```rust
loop {
    watchdog.arm(opts.request_timeout);   // ← 在读帧之前
    let frame = read_frame(transport)?;    // ← 客户端可能空闲很久
    ...
    watchdog.disarm();
}
```

### 1.2 为什么这是缺陷

看门狗的机制是：**独立线程 + 到期调用取消回调**（GUI 侧是 `DisconnectNamedPipe`）。
它**只能杀连接，不能取消单次读**。

于是 `arm()` 在读帧前 → 「客户端多久不发下一个请求」被算进 3 秒超时
→ 用户点开扩展犹豫 3 秒，连接就被断开。

真实 Chrome 验收（阶段 2.7.2）的表现：GUI 日志大量 `serve 结束: 请求超时 (TIMEOUT)`，
后续请求全 `HOST_DISCONNECTED`。

### 1.3 为什么不能"只移动 arm"

单纯把 `arm()` 移到 `read_frame()` 之后 → **半截帧会永久阻塞**：
客户端发 2 字节长度前缀就停住，`read_frame` 会一直等，线程被永久占用。

所以必须**区分三个阶段**。

---

## 2. 修改文件与关键 diff

### 2.1 `framing.rs`：新增"首字节回调"读取

```diff
+pub fn read_frame_on_first_byte<R: Read>(
+    reader: &mut R,
+    on_first_byte: impl FnMut(),
+) -> Result<Vec<u8>, BridgeError> {
+    let mut len_buf = [0u8; 4];
+    read_exact_on_first_byte(reader, &mut len_buf, on_first_byte)?;
+    ...
+}
+
+pub fn read_exact_on_first_byte<R: Read>(
+    reader: &mut R, buf: &mut [u8], mut on_first_byte: impl FnMut(),
+) -> Result<(), BridgeError> {
+    // 收到第一个字节时回调一次，之后不再触发
+}
```

`read_frame` / `read_exact_or_eof` 保持原签名（转调新函数、回调为空），**行为完全不变**。

### 2.2 `server.rs`：三阶段请求循环

```diff
 loop {
-    watchdog.arm(opts.request_timeout);
-    let frame = match read_frame(transport) { ... };
+    // 阶段 1 → 2：首字节到达时才启动超时
+    let frame = match crate::framing::read_frame_on_first_byte(transport, || {
+        watchdog.arm(opts.request_timeout);
+    }) { ... };
+
     if !limiter.allow() {
         reply(...)?;
+        watchdog.disarm();        // ← 补上：限流分支也要撤表
         continue;
     }
     ...
     watchdog.disarm();
 }
```

### 2.3 `server.rs`：新增测试用入口

```diff
+pub fn serve_with_challenge_and_options<T, V>(
+    transport, shared, ops, challenge, opts
+) -> Result<(), BridgeError>
```

存在的理由：测试需要**同时**控制挑战值与超时阈值
（否则随机挑战会让客户端的 proof 必然对不上）。生产路径不变。

---

## 3. 三阶段的超时机制

| 阶段 | 状态 | 看门狗 | 保护 |
| --- | --- | --- | --- |
| **1. 客户端空闲** | 无新请求 | **不 arm** | 连接由 `read_frame` 自然阻塞，**永不因空闲断开** |
| **2. 读帧进行中** | 已收到首字节 | **arm** | 半截帧（长度前缀不足 / 消息体不足）→ 到期断开 |
| **3. 处理请求** | 完整帧已读 | **仍 arm** | 处理超时依旧生效，完成后 `disarm` |

### 为什么阶段 1 安全

没有 arm 时，看门狗线程处于 `deadline = None` 分支，只等待 `Condvar` 通知，
**不会调用取消回调**。连接保持。

### 为什么阶段 2/3 仍受保护

首字节一到就 `arm`。即使客户端只发 2 字节长度前缀就停住，
`read_exact` 会阻塞在 `read()`，3 秒后看门狗调 `DisconnectNamedPipe` → 读返回错误 → 退出。

---

## 4. watchdog 生命周期与竞态

| 关注点 | 处理 |
| --- | --- |
| arm/disarm 竞态 | `Mutex<State>` 保护 `deadline`；`disarm` 置 `None` 后 `notify_all` |
| 超时后误杀已完成请求 | `disarm()` 在 `reply()` **之后**；`fired()` 只在循环末尾检查 |
| 前一次超时污染下一次 | `fired` 是会话级 `AtomicBool`；一旦 `true` 立即 `return Err(Timeout)`，不再进入下一轮 |
| 线程生命周期 | `Watchdog::drop` 置 `shutdown=true` + `notify_all` + `join` |
| 连续请求切换 | 每轮 `disarm` → 下一轮首字节再 `arm`，状态互不污染（T7 有测试） |
| 限流分支 | **补上了 `disarm()`**（修复前该分支 `continue` 时未撤表，会污染下一轮） |

**竞态结论**：`arm`/`disarm`/`fired` 全部由 `Mutex` 或 `AtomicBool` 串行化，
不存在"读到一半被改"的窗口。

---

## 5. T1–T8 测试结果

| 编号 | 测试 | 层 | 结果 |
| --- | --- | --- | --- |
| **T1** | 空闲超过 3 秒后通信仍正常 | **REAL_WINDOWS_PIPE** | **PASS**（空闲 5.0s） |
| T1' | 空闲不触发超时（模拟 transport） | UNIT_TEST | **PASS** |
| **T2** | 连续多个请求（含空闲）全部处理 | UNIT_TEST | **PASS**（3 个请求全部返回） |
| **T3** | 不完整长度前缀 → 安全退出 | UNIT_TEST | **PASS** |
| **T4** | 不完整消息体 → 安全退出 | UNIT_TEST | **PASS** |
| **T5** | 客户端主动断开 → 资源释放 | UNIT_TEST | **PASS** |
| **T6** | 请求处理超时仍生效 | UNIT_TEST | **PASS**（`fill` 延迟 600ms > 阈值 150ms → `Timeout`） |
| **T7** | 超时竞态不误杀后续请求 | UNIT_TEST | **PASS**（2 个请求均成功） |
| **T8** | 原有测试回归 | — | **PASS**（见第 6 节） |

### 真实 Windows 命名管道证据（T1，核心验收）

```
=== 真实 Windows 命名管道：空闲 5 秒测试 ===
  [server] 客户端已连接，开始 serve
  [client] 握手成功
  [client] 空闲 5 秒...
  [client] 空闲结束（5.0s）
  [client] 空闲后写入成功
  [client] 空闲后收到响应:
    {"v":1,"id":"idle1","ok":true,"payload":{"locked":false,"protocol":1,"version":"0.5.0-pipe-test"}}

PASS: 空闲 5 秒后通信仍然正常（核心验收标准达成）
  [client] 第二个请求响应: {"v":1,"id":"idle2","ok":true,...}
PASS: 连续请求（含空闲）均正常，无状态污染
```

**这是真实 `accept_one` / `connect_client` / `serve_with_options` 跑出来的**，
不是模拟 transport。

---

## 6. 全量测试

| 项 | 结果 |
| --- | --- |
| `cargo test --workspace` | **241 通过**（原 234 + 新增 7） |
| `node --test`（扩展） | **91 通过** |
| `cargo fmt --all --check` | **PASS** |
| `cargo clippy -D warnings` | **0 问题** |
| `cargo deny check` | advisories/bans/licenses/sources **全绿** |

### 未删除或弱化任何既有断言

- `keynest-bridge` 原有 50 项单元测试**全部保留**
- 仅新增 `tests/watchdog_phases.rs`（7 项）
- `framing.rs` / `server.rs` 的既有测试未动

---

## 7. Git

```
分支        feat/browser-bridge
基线        a7a991d
本次提交    见 git log -1
main        09b870d（未动）
v0.4.3      2bd390e（未动）
未推送、未合并、未发布
```

---

## 8. 数据保护

| 项 | 状态 |
| --- | --- |
| 真实 vault.dat | **未读取、未修改** |
| 真实 bridge.key | **未读取、未修改**（不存在） |
| Chrome/Edge 注册表 | **未操作** |
| 真实 Chrome | **未启动** |
| GUI | **未启动** |
| 临时目录 | 仅用于管道测试，**已删除** |

---

## 9. 未解决问题与风险

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 半截帧的**具体错误码**因平台而异 | 实测可能是 `Timeout`（看门狗）、`Malformed`（截断识别）或 `Io`（断开）。三者都是安全退出，测试接受全部 |
| 2 | 空闲时连接**永不超时** | 这是刻意设计（用户可能长时间不动）。代价：一个恶意客户端可长期占用一个连接。由 `nMaxInstances=1` + 单线程串行 accept 限制为 1 个 |
| 3 | 会话 TTL（30 分钟）仍在 | 空闲不会触发，但超过 30 分钟会 `NoSession` |
| 4 | 未在真实 Chrome 复测 | 本阶段禁止。修复的正确性由真实 Windows 管道测试证明 |

---

## 10. 停止点

**本阶段完成，已停止。**

- 未进入下一阶段
- 未启动真实 Chrome / GUI / Host
- 未注册 Host / Edge
- 未推送、未合并、未发布
- main 与 v0.4.3 未动

**核心验收标准达成**：客户端空闲超过 3 秒仍能正常通信，同时不完整帧与超时请求仍受保护。
