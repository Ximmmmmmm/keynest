# KeyNest 阶段 2.6 · 注册前审计与隔离环境准备（Preflight）

> 分支 `feat/browser-bridge` · HEAD `df76d07` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 工作区：干净（本报告为唯一新增文件）
> 日期：2026-11-02
> **本报告只做审计。未写注册表、未启动 GUI/Host、未创建临时库、未触碰真实库。**

---

## 0. 结论先行

| 项 | 结论 |
| --- | --- |
| 隔离是否可行 | **可行**。`KEYNEST_DATA_DIR` 一次设置同时隔离 `vault.dat`、`vault.lock`、`bridge.key` |
| 注册脚本是否安全 | **安全**（只写 HKCU 两条子键、无 HKLM、无下载、无远程执行、失败回滚、卸载只删自己） |
| 是否需要改动 | **需要一处最小改动**：manifest 目录硬编码为 `%LOCALAPPDATA%\KeyNest`，测试期无法完全清理 → 建议加 `-ManifestDir` 参数 |
| 是否会覆盖已有内容 | **不会**。两条子键当前均不存在，manifest 也不存在 |
| 是否可以进入第二部分 | **可以，但需你确认两件事**（见第 10 节） |

---

## 1. 注册脚本审计（逐项）

脚本：`scripts/register-native-host-dev.ps1`（UTF-8 BOM，PS 5.1 可解析）

| # | 检查项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 只写 HKCU，不写 HKLM | **PASS** | 全文无 `HKLM`/`HKEY_LOCAL_MACHINE`；所有路径 `HKCU:\` |
| 2 | 只创建 KeyNest 自己的注册项 | **PASS** | 只操作 `com.keynest.bridge` 一个子键 |
| 3 | 不修改其他软件注册项 | **PASS** | 不枚举、不清空父键 `NativeMessagingHosts` |
| 4 | 不需要管理员权限 | **PASS** | 无 `#Requires -RunAsAdministrator`，无提权调用 |
| 5 | 扩展 ID 严格校验 | **PASS** | `^[a-p]{32}$` 正则；无 ID 直接报错退出 |
| 6 | manifest 路径准确 | **PASS（但有隔离缺口）** | `%LOCALAPPDATA%\KeyNest\com.keynest.bridge.json`，与 Rust 侧约定一致；**但硬编码，不跟随 `KEYNEST_DATA_DIR`** |
| 7 | host executable 路径准确 | **PASS** | `-HostExe` 参数 + `Resolve-Path` + `Test-Path` 校验 |
| 8 | allowed_origins 只含本项目真实 ID | **PASS** | 只拼 `chrome-extension://<传入ID>/` |
| 9 | 不使用通配符 | **PASS** | 无 `*` |
| 10 | 不执行下载或远程脚本 | **PASS** | 无 `Invoke-WebRequest`/`Invoke-Expression`/`iex`/`curl` |
| 11 | 不触碰 vault.dat | **PASS** | 全文无 `vault` 引用（仅注释提到"不碰"） |
| 12 | 不触碰真实 bridge.key | **PASS** | 全文无 `bridge.key` 引用 |
| 13 | 失败时回滚自身注册项 | **PASS** | `try/catch` → `Remove-OurRegistry` + 删 manifest → `throw` |
| 14 | 卸载只删自己的项 | **PASS** | `Remove-OurRegistry` 只删 `com.keynest.bridge` 两个子键 |

### 唯一缺口（不影响 vault/bridge.key 隔离）

```powershell
$DataDir = Join-Path $env:LOCALAPPDATA 'KeyNest'   # 第 41 行，硬编码
```

**影响**：测试期 manifest 会写到真实 `%LOCALAPPDATA%\KeyNest\`。
manifest 本身**不含任何密钥或密码**，且 Native Host **不读取数据目录**（已核实），
所以**不会污染真实 vault 或 bridge.key**。但测试结束后该目录会残留一个 manifest 文件。

**最小修复建议**（本阶段不实施，等你批准）：

```powershell
param(
    [string]$ManifestDir = (Join-Path $env:LOCALAPPDATA 'KeyNest'),
    ...
)
$DataDir = $ManifestDir
```

默认行为不变；测试时传 `-ManifestDir "$env:TEMP\KeyNest-Phase2.6-Test"` 即可完全清理。

---

## 2. 注册表变更预览

### 2.1 将要创建的两条键

| # | 完整键路径 | 类型 | 值名 | 值类型 | 预期值 |
| --- | --- | --- | --- | --- | --- |
| 1 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge` | 注册表项 | `(默认)` | `REG_SZ` | `<manifest 绝对路径>` |
| 2 | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge` | 注册表项 | `(默认)` | `REG_SZ` | `<manifest 绝对路径>` |

（若只传 `-ChromeId`，则只创建第 1 条。）

### 2.2 当前状态（只读实测）

```
HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge   exists=False
HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.keynest.bridge  exists=False

父键（系统自带，不属 KeyNest）：
HKCU:\Software\Google\Chrome\NativeMessagingHosts   exists=True
HKCU:\Software\Microsoft\Edge\NativeMessagingHosts  exists=True
```

| 检查 | 结果 |
| --- | --- |
| 两条键是否都是 KeyNest 自己的 | **是**（名字固定为 `com.keynest.bridge`） |
| 注册前是否已存在 | **否**（两条都不存在） |
| 是否会覆盖旧值 | **不会**（无旧值可覆盖） |

---

## 3. Native Host manifest 内容（预览，尚未写入）

```jsonc
{
  "name": "com.keynest.bridge",
  "description": "KeyNest Browser Bridge",
  "path": "<HostExe 绝对路径>",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<扩展ID>/"]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 固定 `com.keynest.bridge`，必须与扩展里 `connectNative('com.keynest.bridge')` 一致 |
| `path` | 必须是**绝对路径**，由 `-HostExe` 传入并 `Resolve-Path` |
| `type` | `stdio`（浏览器通过 stdin/stdout 通信） |
| `allowed_origins` | 只含传入的扩展 ID，**无通配符** |

---

## 4. 扩展 ID

**实测（真实 Chrome 156，CDP `Extensions.loadUnpacked`）**：

```
nkmbkncopjdbdleomifkloegjjfpccjk
```

说明：

- 这是**开发模式按路径生成的 ID**，路径不变则 ID 稳定。
- 换路径（例如复制到别的目录）→ ID 会变 → 必须重新注册。
- **不是**商店正式 ID；本阶段不涉及商店上架（决策 5）。

---

## 5. Native Host executable 路径

| 项 | 值 |
| --- | --- |
| 构建产物 | `rust/target/debug/keynest-native-host.exe` |
| 当前是否存在 | 见第 11 节实测 |
| 大小 | 约 227 KB（阶段 2 记录） |
| 二进制名 | `keynest-native-host`（`keynest-bridge/Cargo.toml` 的 `[[bin]]`） |

**注意**：本阶段不构建、不启动（属第二部分）。

---

## 6. `bridge.key` 路径与隔离方案

### 6.1 路径决定链（读代码确认）

```
keynest-egui/src/app.rs:289
  BridgeService::new(keynest_core::paths::resolve_data_dir())
        │
        ▼
keynest-core/src/paths.rs:resolve_data_dir()
  1. KEYNEST_DATA_DIR 环境变量        ← 最高优先级
  2. %APPDATA%\KeyNest（若 vault.dat 已存在，兼容旧位置）
  3. %LOCALAPPDATA%\KeyNest
        │
        ▼
keynest-bridge/src/keyfile.rs:key_path(dir) = dir / "bridge.key"
```

**结论：`bridge.key` 与 `vault.dat`、`vault.lock` 同目录，同一个 `resolve_data_dir()` 决定。**

### 6.2 隔离能力逐项

| 问题 | 答案 |
| --- | --- |
| 是否跟随 `KEYNEST_DATA_DIR` | **是**（最高优先级） |
| 是否可能覆盖真实 bridge.key | **否**（设了 `KEYNEST_DATA_DIR` 就完全走另一目录） |
| 启动 GUI 时是否自动生成 | **是，但仅在解锁后**：`BridgeService::start()` 才调 `load_or_create` |
| 是否有测试专用隔离配置 | **有**：`KEYNEST_DATA_DIR` |
| Native Host 是否也读它 | **否**。`native_host.rs` 全文无 `KEYNEST_DATA_DIR`/`keyfile` 引用；`keynest-bridge` 不依赖 `keynest-core`，**没有能力打开 vault.dat** |

### 6.3 真实环境当前状态（实测）

```
%LOCALAPPDATA%\KeyNest\           → 目录不存在
%LOCALAPPDATA%\KeyNest\bridge.key → 不存在
%APPDATA%\KeyNest\vault.dat       → 存在，42228 字节
```

真实 `bridge.key` **从未生成过**（GUI 从未解锁启动过桥接）。

### 6.4 隔离方案（第二部分将采用）

```powershell
$env:KEYNEST_DATA_DIR = "C:\Users\XIM\AppData\Local\Temp\KeyNest-Phase2.6-Test\data"
```

一次设置同时隔离：

- `vault.dat`
- `vault.lock`
- `bridge.key`

**真实 `%APPDATA%\KeyNest\vault.dat` 与 `%LOCALAPPDATA%\KeyNest\bridge.key` 都不会被读或写。**

---

## 7. 临时 vault 路径（第二部分使用，本阶段不创建）

| 项 | 值 |
| --- | --- |
| 根目录 | `C:\Users\XIM\AppData\Local\Temp\KeyNest-Phase2.6-Test\` |
| 数据目录 | `...\data\`（`KEYNEST_DATA_DIR` 指向它） |
| vault | `...\data\vault.dat` |
| lock | `...\data\vault.lock` |
| bridge.key | `...\data\bridge.key` |
| manifest（若批准修复） | `...\manifest\com.keynest.bridge.json` |

**主密码**：虚构（第二部分使用，不写入报告）
**测试条目**：虚构账号 + 虚构密码（不写入报告）

---

## 8. 真实 vault 未被访问或修改的证据

| 项 | 测试前实测值 |
| --- | --- |
| 路径 | `C:\Users\XIM\AppData\Roaming\KeyNest\vault.dat` |
| size | `42228` |
| mtime | `2026-11-01 23:19:17.191727900 +0800` |
| MD5 | `2bd94cde0fa7d1e1166c930324f763c` |
| 真实 bridge.key | **不存在** |
| `%LOCALAPPDATA%\KeyNest\` 目录 | **不存在** |

本阶段**未打开、未读取内容、未修改**该文件。上述为 `stat`/`md5sum` 元数据读取。

---

## 9. 预计执行的注册表操作（第二部分，待批准）

| 顺序 | 操作 | 目标 | 可回滚 |
| --- | --- | --- | --- |
| 1 | 写 manifest 文件 | `<ManifestDir>\com.keynest.bridge.json` | 删文件 |
| 2 | 创建键 + 设默认值 | `HKCU\...\Chrome\NativeMessagingHosts\com.keynest.bridge` | 删键 |
| 3 | 创建键 + 设默认值 | `HKCU\...\Edge\NativeMessagingHosts\com.keynest.bridge`（可选） | 删键 |

**不涉及**：HKLM、其他软件项、vault.dat、bridge.key、系统 PATH、浏览器设置。

---

## 10. 风险与回滚

| # | 风险 | 等级 | 缓解 / 回滚 |
| --- | --- | --- | --- |
| 1 | 注册项残留 | 低 | `-Uninstall` 只删这两条键 + manifest |
| 2 | manifest 写到真实目录 | 低 | 建议加 `-ManifestDir`（见第 1 节） |
| 3 | 误用真实主密码 | 中 | 全程用 `KEYNEST_DATA_DIR` 指向临时库；GUI 只开临时库 |
| 4 | 真实库被读 | **低（已消除）** | `KEYNEST_DATA_DIR` 优先，代码确认 |
| 5 | 测试密码进日志 | 中 | 报告只写"填充成功/失败"，不写值；Host stderr 只写错误码 |
| 6 | Chrome 用真实 profile | 中 | 全程 `--user-data-dir` 独立临时目录 |
| 7 | 扩展 ID 与 manifest 不匹配 | 低 | 用实测 ID `nkmbkn...`；不匹配时浏览器直接拒绝连接（安全失败） |

**总回滚方式**：

```powershell
.\scripts\register-native-host-dev.ps1 -Uninstall
Remove-Item -Recurse -Force "$env:TEMP\KeyNest-Phase2.6-Test"
```

---

## 11. 第二部分执行前需要你确认

| # | 事项 | 需要你决定 |
| --- | --- | --- |
| 1 | **是否批准写 HKCU 两条注册表键** | 这是本阶段唯一的系统级改动 |
| 2 | **是否批准给注册脚本加 `-ManifestDir`**（1 处参数化，默认行为不变） | 不加则测试后 `%LOCALAPPDATA%\KeyNest\` 会残留一个 manifest |
| 3 | 是否同时注册 Edge，还是只测 Chrome | 只测 Chrome 可少写一条键 |

**另外说明**：第二部分需要 GUI 用**虚构主密码**解锁**临时库**。我不会使用你的真实主密码，也不会碰真实库。

---

## 12. 本阶段实际动作清单（证明未越界）

| 动作 | 执行 |
| --- | --- |
| 读 Git 状态 | 是 |
| 读脚本源码 | 是 |
| 读 `paths.rs` / `keyfile.rs` / `app.rs` 源码 | 是 |
| 只读注册表（`Test-Path`） | 是 |
| `stat` + `md5sum` 真实库 | 是（仅元数据） |
| 写注册表 | **否** |
| 启动 GUI / Host | **否** |
| 创建临时库 | **否** |
| 构建 Host 二进制 | **否** |
| 修改任何代码 | **否** |

---

## 13. 停止点

**第一部分完成。等你的三项确认后，才进入第二部分。**

未写注册表、未启动任何组件、未创建临时库、未触碰真实库。
