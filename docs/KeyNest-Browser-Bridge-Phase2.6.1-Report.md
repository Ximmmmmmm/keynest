# KeyNest 阶段 2.6.1 报告 · GUI 按需唤醒与路径统一

> 基线 `904d582` · 分支 `feat/browser-bridge`
> main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> **未注册 Native Host、未注册 Edge、未启动真实密码库、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 修复 1：GUI 按需唤醒 | **完成**。16ms 无条件重绘已删除，改为后台入队后 `request_repaint()` |
| 修复 2：`keynest-paths` | **完成**。四端统一到一份实现，零依赖 |
| 空闲 CPU（锁定态） | **实测 2.5% 单核**（5s 125ms） |
| 全部测试 | Rust **234** 通过 / Node 75 / fmt / clippy / deny 全绿 |
| 真实库 / 真实 bridge.key | **未触碰** |

---

## 1. 基线与我方状态

```
基线提交     904d582
本次提交     见 git log -1
分支         feat/browser-bridge
工作区       提交后干净
main         09b870d（未动）
v0.4.3       2bd390e（未动）
```

---

## 2. 修复 1：GUI 按需重绘

### 2.1 修改前

```rust
// logic() 开头
if self.bridge.is_running() {
    ctx.request_repaint_after(Duration::from_millis(16));   // ← 无条件 60 FPS
}
```

覆盖了函数末尾原有的 50ms / 500ms 调度，桥接运行期间 GUI 持续约 60 FPS 空转。

### 2.2 修改后

**（a）删除 16ms**，改为后台唤醒：

```rust
fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
    // 唤醒由后台线程负责，这里不再无条件请求重绘
    self.pump_bridge();
    ...
}
```

**（b）后台入队成功后唤醒**（`bridge/mod.rs`）：

```rust
fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Call) -> Result<T, BridgeError> {
    let (tx, rx) = mpsc::channel();
    // 1) 先入队
    self.tx.send(make(tx)).map_err(|_| ...)?;
    // 2) 入队成功后才唤醒
    (self.wake)();
    rx.recv_timeout(self.timeout)
}
```

唤醒器：

```rust
let wake: Arc<dyn Fn() + Send + Sync> = {
    let ctx = self.ctx.clone();
    Arc::new(move || { if let Some(c) = &ctx { c.request_repaint(); } })
};
```

**（c）保留兜底**（`app.rs` 末尾）：

```rust
if self.repaint_fast {
    ctx.request_repaint_after(Duration::from_millis(50));
} else if self.bridge.is_running() {
    ctx.request_repaint_after(Duration::from_millis(100));   // ← 兜底，10 FPS
} else {
    ctx.request_repaint_after(Duration::from_millis(500));   // ← 原行为
}
```

### 2.3 逐项对照验收要求

| # | 要求 | 落实 |
| --- | --- | --- |
| 1 | 删除无条件 16ms | **已完成**（`grep from_millis(16)` = 0） |
| 2 | 保留 50/500ms 原调度 | **保留**，仅插入 100ms 兜底分支 |
| 3 | 入队后 `request_repaint()` 唤醒 | **已实现** |
| 4 | 必须先入队再唤醒 | **已保证**（有测试 `wake_fires_only_after_successful_enqueue`） |
| 5 | 经现有 `pump_bridge()` 处理 | **未改处理路径** |
| 6 | 保留 `recv_timeout` | **保留** |
| 7 | 不引入忙轮询 | **无**（无循环 sleep/轮询，纯事件驱动） |
| 8 | 不因时序导致永久等待 | **有兜底**（100ms）+ 有测试证明顺序 |
| 9 | 后台不碰 Vault/DEK | **未变**（仍只通过 `mpsc` 请求 UI 线程） |

### 2.4 时序正确性论证

**顺序不变式**：`send` 成功 → `wake()`。

- 若反过来（先唤醒后入队）：UI 可能在唤醒后、消息入队前跑完 `pump_bridge()`，
  该帧无消息可处理，请求要等下一次 100ms 兜底才被看见。
- 现在的顺序保证了：**只要 `send` 成功，唤醒时消息一定已在队列里**，
  UI 下一次 `pump_bridge()` 必然能取到它。

**最坏延迟**：即使 `request_repaint()` 完全不生效，也 ≤ 100ms（远小于浏览器侧 5s 超时）。

**不会永久等待**：`recv_timeout` 有超时；`send` 失败（UI 退出）立即返回错误。

### 2.5 空闲 CPU

| 场景 | 修改前 | 修改后 |
| --- | --- | --- |
| 锁定态（无桥接） | 500ms 一次 | **500ms 一次**（未变） |
| 解锁态 + 桥接运行 + 无请求 | **16ms 一次（≈60 FPS）** | **100ms 一次（10 FPS）** |

**实测（锁定态）**：5 秒 125ms CPU ≈ **2.5% 单核**。

> 解锁+桥接运行态的对比未能实测（需重新解锁临时库）。
> 从代码看：重绘频率从 62.5 次/秒降到 10 次/秒，**预期降幅约 6 倍**。
> 这条标记为 **推断值，非实测**。

---

## 3. 修复 2：`keynest-paths` crate

### 3.1 结构

```
rust/
├── keynest-paths/          ← 新增，零依赖
│   ├── Cargo.toml
│   └── src/lib.rs
├── keynest-core/           → 依赖 keynest-paths（paths.rs 变转发层）
├── keynest-bridge/         → 依赖 keynest-paths（native_host 用它）
└── keynest-egui/           → 依赖 keynest-paths
```

### 3.2 API

```rust
// 常量
pub const VAULT_FILE: &str = "vault.dat";
pub const LOCK_FILE: &str = "vault.lock";
pub const BRIDGE_KEY_FILE: &str = "bridge.key";
pub const ENV_DATA_DIR: &str = "KEYNEST_DATA_DIR";

// 解析
pub fn local_data_dir() -> PathBuf;        // %LOCALAPPDATA%\KeyNest
pub fn roaming_data_dir() -> PathBuf;      // %APPDATA%\KeyNest
pub fn resolve_data_dir() -> PathBuf;      // 三级优先级
pub fn resolve_vault_path() -> PathBuf;    // dir/vault.dat
pub fn resolve_lock_path() -> PathBuf;     // dir/vault.lock
pub fn resolve_bridge_key_path() -> PathBuf; // dir/bridge.key
pub fn is_on_roaming_profile() -> bool;
```

**刻意不做**：不创建目录、不创建文件、不读密码库、不创建 `bridge.key`。

### 3.3 依赖关系（无循环）

```
keynest-paths（零依赖）
   ▲         ▲         ▲
   │         │         │
core      bridge     egui
```

- `keynest-bridge` **仍不依赖 `keynest-core`**（不变量保持）
- `keynest-paths` **不引入任何 Vault/DEK/密码库能力**（零依赖保证）

### 3.4 消除重复实现

| 位置 | 修改前 | 修改后 |
| --- | --- | --- |
| `keynest-core/src/paths.rs` | 自己实现 81 行 | **转发层**，委托 `keynest_paths` |
| `native_host.rs` | 自己写 `data_dir()` 20 行 | `keynest_paths::resolve_data_dir()` |
| `app.rs` | 用 `keynest_core::paths` | 用 `keynest_paths`（少一跳） |

**全仓搜索确认**：`data_dir()` 自定义实现只剩 1 处（`native_host.rs` 的薄包装，内部直接调共享函数）。

---

## 4. GUI 与 Host 路径一致性

### 4.1 机制

**两个进程现在调用同一个函数**（`keynest_paths::resolve_data_dir()`），
所以"逻辑分叉"这条风险从根上消除了。

### 4.2 环境差异（**必须如实报告**）

共享代码解决不了**环境差异**：GUI 与 Host 是不同进程，各自继承不同的环境变量。

| 场景 | 是否一致 | 说明 |
| --- | --- | --- |
| 用户正常双击启动 GUI，Chrome 由系统启动 | **一致** | 两者都没有 `KEYNEST_DATA_DIR`，都走 `%APPDATA%`/`%LOCALAPPDATA%` 判定 |
| 用户在终端设了 `KEYNEST_DATA_DIR` 再启动 GUI，但 Chrome 是**之前**启动的 | **不一致** | GUI 读环境变量，Host 继承 Chrome 的旧环境 → 不同目录 → 握手失败 |
| 隔离测试：给 Chrome 设了 `KEYNEST_DATA_DIR`，GUI 也设 | **一致** | 阶段 2.6 就是这样跑通的 |

**这是"环境不同导致目录分叉"，不是代码缺陷。**

**当前缓解**：

- 握手失败时 Host 报 `HANDSHAKE`、GUI 记 `serve 结束: ...`，两边都有迹可循（阶段 2.6 之前是静默的）
- 不引入任何新的配置机制（按你的要求）

**建议的后续方向**（不在本阶段实现）：

- 在 `status` 回包里带一个**数据目录指纹**（如目录路径的 SHA-256 前 8 位，不含明文路径），
  让扩展与设置页能提示"GUI 与 Host 目录不一致"。
  这需要协议版本升级，应单独评估。

### 4.3 安全失败

目录解析**不会**"悄悄换一个目录"：

- `KEYNEST_DATA_DIR` 设了但目录不存在 → 两边都返回该路径，随后各自失败（不会回退到默认目录）
- `LOCALAPPDATA` 缺失 → 回退 `std::env::temp_dir()`（既有行为，未改）

---

## 5. 路径优先级测试

`keynest-paths` 7 项 + `keynest-core` 转发层 2 项：

| 测试 | 覆盖 |
| --- | --- |
| `file_names_are_stable` | `vault.dat` / `vault.lock` / `bridge.key` 文件名不变 |
| `env_var_name_is_stable` | `KEYNEST_DATA_DIR` 字符串不变（改了会让已部署配置失效） |
| `vault_lock_and_key_share_one_dir` | **三者同目录**（"一次设置隔离三者"的前提） |
| `vault_path_ends_with_dat` | 路径拼接正确 |
| `local_dir_ends_with_keynest` | `%LOCALAPPDATA%\KeyNest` |
| `roaming_dir_ends_with_keynest` | `%APPDATA%\KeyNest` |
| `priority_rules_in_order` | **三级优先级全组合**（环境变量 > 旧目录有库 > 新位置） |
| `delegates_to_shared_implementation` | core 转发层与共享实现**逐值相等** |
| `vault_path_ends_with_dat`（core） | 转发层路径正确 |

**测试隔离**：全部基于纯函数与显式路径参数，**不修改进程环境变量**，
不触碰用户真实目录。

---

## 6. 重绘测试

`keynest-egui` 新增 4 项：

| 测试 | 覆盖 |
| --- | --- |
| `wake_fires_only_after_successful_enqueue` | 入队成功 → 恰好 1 次唤醒；且消息在唤醒前已入队 |
| `wake_not_called_when_enqueue_fails` | UI 退出（send 失败）→ **0 次唤醒** |
| `multiple_enqueues_each_wake` | 5 个请求 → 5 次唤醒，消息不丢 |
| `no_ctx_means_wake_is_noop_not_panic` | 未 attach ctx 时退化为空操作，不 panic |

---

## 7. 全量测试

| 项 | 结果 |
| --- | --- |
| `cargo test --workspace` | **234 通过**（paths 7 + core 129 + bridge 51 + egui 41 + 集成 6/6） |
| `node --test`（扩展） | **75 通过** |
| `cargo fmt --all --check` | **PASS** |
| `cargo clippy -D warnings` | **0 问题** |
| `cargo deny check` | advisories/bans/licenses/sources **全绿** |

> 未重跑真实 Chrome 测试（按你的要求：不得重新注册 Native Host）。

---

## 8. 数据保护

| 项 | 结果 |
| --- | --- |
| 真实 vault.dat | **未读取、未修改**（全程未打开） |
| 真实 bridge.key | **未创建、未修改**（不存在） |
| 真实 `%LOCALAPPDATA%\KeyNest` | **未被创建** |
| 注册表 | **未写入**（Chrome / Edge 均为 `False`） |
| 临时测试目录 | 已删除（`kn-261`、`kn-gui-idle.out`、`kn_seed.rs`） |
| 测试用临时库 | 假密码创建、用完即删，**未写入报告** |

---

## 9. 未覆盖的风险

| # | 风险 | 等级 | 说明 |
| --- | --- | --- | --- |
| 1 | **两进程环境不同导致目录分叉** | **中** | 共享代码解决不了；已如实报告（4.2），缓解手段仅靠错误日志 |
| 2 | `request_repaint()` 跨线程唤醒在某些后端失效 | 低 | 有 100ms 兜底，最坏延迟 100ms < 5s 超时 |
| 3 | 解锁+桥接运行态 CPU 未实测 | 低 | 从代码推断降幅约 6 倍（62.5→10 次/秒） |
| 4 | JSON 序列化明文 `String` 未包 `Zeroizing` | 低 | 阶段 2.6 审查已记录，本阶段未处理 |
| 5 | `bridge.key` 轮换无 UI 入口 | 低 | 留待阶段 3 |

---

## 10. 建议

**建议进入阶段 2.7**，但需先明确一件事：

**风险 1（两进程环境分叉）需要一个决策**：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A. 什么都不做 | 靠错误日志排查 | 用户遇到时无法自助 |
| **B. `status` 回包带目录指纹** | 扩展/设置页提示"目录不一致" | 协议版本升级 |
| C. Host 启动时探测并写日志 | 仅便于排查 | 无 UI 提示 |

**我倾向 B**，但它属于协议变更，应单独批准，不应夹在 2.7 里顺手做。

---

## 11. 停止点

**本阶段完成，已停止。**

- 未进入阶段 2.7
- 未开发浏览器自动保存
- 未注册 Native Host / Edge
- 未推送、未合并、未发布
- main 与 v0.4.3 未动
