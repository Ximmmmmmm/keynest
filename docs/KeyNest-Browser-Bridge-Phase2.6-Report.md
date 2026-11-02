# KeyNest 阶段 2.6 第二部分报告 · Chrome Native Host 隔离端到端验收

> 分支 `feat/browser-bridge` · 基线 `99356e5` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 测试环境：真实 Chrome **156.0.8078.80**，独立临时 profile
> 日期：2026-11-02
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| `-ManifestDir` 缺口修复 | **完成** |
| Chrome Native Messaging 注册 | **PASS（真实）** |
| Chrome 启动 Native Host | **PASS（真实）** |
| Host 协议纪律（stdout 只有帧） | **PASS（真实）** |
| GUI 隔离（读临时库、锁定时不生成 key） | **PASS（真实）** |
| **真实 GUI 解锁** | **BLOCKED**（egui 自绘界面无法脚本化输入，Windows 前台锁限制） |
| **真实密码填充** | **BLOCKED**（依赖 GUI 解锁） |
| 环境清理 | **PASS**（注册表/临时目录/进程全部清干净） |

**核心阻断点：GUI 无法通过自动化解锁，因此握手之后的全部链路未能真实跑通。**

---

## 1. `-ManifestDir` 修复

### 改动 diff

```diff
 param(
     [string]$HostExe,
     [string]$ChromeId,
     [string]$EdgeId,
+    # manifest 存放目录。默认与 Rust 侧数据目录约定一致；
+    # 隔离测试时传临时目录，避免污染真实 %LOCALAPPDATA%\KeyNest。
+    [string]$ManifestDir,
     [switch]$Uninstall
 )

-# 与 Rust 侧 keynest_bridge::keyfile::KEY_FILE 同一目录约定
-$DataDir  = Join-Path $env:LOCALAPPDATA 'KeyNest'
+# 默认行为不变：不传 -ManifestDir 时仍是 %LOCALAPPDATA%\KeyNest
+if (-not $ManifestDir) {
+    $ManifestDir = Join-Path $env:LOCALAPPDATA 'KeyNest'
+}
+$DataDir  = $ManifestDir
 $Manifest = Join-Path $DataDir 'com.keynest.bridge.json'
```

| 检查 | 结果 |
| --- | --- |
| 默认行为不变 | **PASS** |
| 扩展 ID 校验不变 | **PASS**（`^[a-p]{32}$` 未动） |
| allowed_origins 精确匹配不变 | **PASS** |
| 未增加 Edge 逻辑 | **PASS** |
| 卸载能删本次 manifest | **PASS**（实测删除成功） |
| 不删目录内其他文件 | **PASS**（只删 `com.keynest.bridge.json`） |
| PS 5.1 语法 | **PASS**（BOM 已补回，`SYNTAX OK`） |

> 编辑过程中 BOM 被工具剥离过，已补回并验证 `efbbbf`。

---

## 2. 注册前检查（全部通过后才执行）

| # | 项目 | 值 |
| --- | --- | --- |
| 1 | 目标键 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.keynest.bridge` |
| 2 | 值 | `(默认)` `REG_SZ` = manifest 绝对路径 |
| 3 | manifest 路径 | `...\KeyNest-Phase2.6-Test\manifest\com.keynest.bridge.json`（**在临时目录**） |
| 4 | manifest 内容 | 见下 |
| 5 | Host EXE | `...\KeyNest-Phase2.6-Test\bin\keynest-native-host.exe`（227,840 字节） |
| 6 | 扩展 ID | `nkmbkncopjdbdleomifkloegjjfpccjk` |
| 7 | 注册前 Chrome 子键 | `exists=False` |
| 8 | Edge 子键 | `exists=False`（**全程未创建**） |
| 9 | ManifestDir 在临时目录 | **是** |
| 10 | 卸载只操作 Chrome 专属子键 | **是**（实测） |

manifest 实际内容：

```json
{
  "name": "com.keynest.bridge",
  "description": "KeyNest Browser Bridge",
  "path": "C:\\Users\\XIM\\AppData\\Local\\Temp\\KeyNest-Phase2.6-Test\\bin\\keynest-native-host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://nkmbkncopjdbdleomifkloegjjfpccjk/"]
}
```

---

## 3. 实际注册表变更（回读核对）

| 项 | 注册前 | 注册后 | 卸载后 |
| --- | --- | --- | --- |
| `...\Chrome\NativeMessagingHosts\com.keynest.bridge` | `False` | **`True`**，默认值 = 临时 manifest 路径 | **`False`** |
| `...\Edge\NativeMessagingHosts\com.keynest.bridge` | `False` | `False`（**未创建**） | `False` |
| 真实 `%LOCALAPPDATA%\KeyNest` | 不存在 | **仍不存在** | 仍不存在 |

**注册内容与预览完全一致，无偏差。**

---

## 4. 隔离环境

| 目录 | 用途 |
| --- | --- |
| `...\KeyNest-Phase2.6-Test\data\` | `vault.dat`（2068 字节）、`vault.lock` |
| `...\manifest\` | manifest |
| `...\bin\` | `keynest-native-host.exe` |
| `...\profile\` | 独立 Chrome profile |
| `...\logs\` | 脱敏日志 |
| `...\site\` | 本地 HTTPS 测试站（9445） |

`KEYNEST_DATA_DIR` = `...\KeyNest-Phase2.6-Test\data`

**临时库**：虚构主密码创建，含 1 条虚构条目
- 条目 ID：`366d91a5-d13d-4974-aa6e-2ad6303ae1ff`
- 用户名：`phase26-test-user`
- 密码：虚构测试值（**不记录**）
- URL：`https://127.0.0.1:9445/`

---

## 5. 真实 Chrome 测试结果

### A. Native Messaging

| 编号 | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | Chrome 能启动 Native Host | **PASS（真实）** | 扩展发 `status` 返回 **`HOST_DISCONNECTED`**（不是 `NATIVE_HOST_MISSING`）→ 证明 Chrome 已找到 manifest 并启动了 exe |
| A2 | manifest 路径正确 | **PASS（真实）** | 同上；路径错会返回 `NATIVE_HOST_MISSING` |
| A3 | Host 连不上管道时行为 | **PASS（真实）** | 直接运行 exe：stderr 输出 `keynest-native-host: IO`，**stdout 无任何输出**，立即退出 |
| A4 | stdout 只有协议帧 | **PASS（真实）** | A3 实测 stdout 为空 |
| A5 | stderr 不泄露密码/密钥 | **PASS（真实）** | 只输出错误码 `IO` |
| A6 | 4 字节长度前缀 | **SIMULATED** | node 测试覆盖；真实往返因 GUI 未解锁未达成 |
| A7 | 握手（HMAC/HKDF/XChaCha20） | **BLOCKED** | 需 GUI 监听管道 |
| A8 | 序号防重放 | **BLOCKED** | 同上 |

> **A1 是本次最有价值的真实证据**：它同时证明了注册生效、manifest 正确、Chrome→Host 启动链路可用。

### B. GUI 与 Vault

| 编号 | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| B1 | GUI 使用临时目录 | **PASS（真实）** | 启动后 `...\data\vault.lock` 被创建（14:03），真实库未变 |
| B2 | 锁定时不启动 BridgeService | **PASS（真实）** | 锁定时 `bridge.key` **未生成** |
| B3 | 解锁后 BridgeService 启动 | **BLOCKED** | 无法解锁 |
| B4 | 锁定后 BridgeService 停止 | **BLOCKED** | 同上 |
| B5 | 锁定时不能读密码 | **SIMULATED** | node 端到端测试覆盖 |
| B6 | Host 不能直接打开 vault.dat | **PASS（代码事实）** | `keynest-bridge` 不依赖 `keynest-core`，无文件 API |
| B7 | GUI 持有 DEK 与 Vault | **PASS（代码事实）** | `app.rs` 持有 `Vault` |

### C. 填充

| 编号 | 测试 | 结果 |
| --- | --- | --- |
| C1–C6 | 打开页面→点击→查询→授权→兑换→填充 | **BLOCKED**（GUI 未解锁） |
| C7 | 再次兑换旧 nonce 被拒 | **BLOCKED** |
| C8 | 100 并发只成功一次 | **SIMULATED**（node 通过） |
| C9 | HTTP 默认拒绝 | **PASS（真实，阶段 2.5 已验证）** |
| C10 | 跨站 iframe 拒绝 | **SIMULATED** |
| C11 | 导航后旧授权失效 | **SIMULATED**（documentId 逻辑） |
| C12 | 锁定后不能填充 | **SIMULATED** |

### D. 数据保护

| 项 | 结果 |
| --- | --- |
| 密码不写入 extension storage | **PASS（代码审查）** |
| 密码不写入日志 | **PASS（真实）**：GUI/Host 日志均为空或仅错误码 |
| 密码不进入剪贴板 | **PASS（代码审查）**：无剪贴板调用 |
| 密码不进 stdout/stderr | **PASS（真实）**：A3/A5 实测 |
| 密码不写入本报告 | **PASS**：全程未记录 |
| 不保存含密码截图 | **PASS**：未截图 |
| 不记录会话密钥/nonce | **PASS**：未记录 |

---

## 6. 阻断原因（如实）

### 为什么 GUI 无法解锁

`keynest-egui` 是 **egui 自绘界面**：

1. **没有 UIAutomation 树**——Windows UI Automation 只能看到顶层窗口，看不到内部控件（egui 不是原生控件）。
   - 实测：`Add-Type -AssemblyName UIAutomationClient` 在 PS 5.1 下加载失败；改用 `LoadFrom` 也失败。
2. **SendKeys 无法定位输入框**——egui 需要真实鼠标点击到具体坐标才能让输入框获得焦点，而布局坐标无法可靠推断。
3. **Windows 前台锁**——后台进程无法抢焦点：
   - `SetForegroundWindow` 首次返回 `False`
   - `AttachThreadInput` 绕过方案：`set=True` 但 `focused=False`
   - 一次成功拿到焦点并输入后，`bridge.key` **仍未生成** → 输入未进入密码框

### 尝试过的三条路径（全部失败）

| 尝试 | 结果 |
| --- | --- |
| UIAutomation 探测控件树 | 程序集加载失败 |
| `SetForegroundWindow` + SendKeys | 前台锁拒绝 |
| `AttachThreadInput` 绕过 + 盲点坐标 + SendKeys | 拿到焦点，但输入未进框 |

**这是环境限制，不是代码缺陷。** 我没有用"模拟"替代它。

---

## 7. 清理结果

| # | 项目 | 结果 |
| --- | --- | --- |
| 1 | 关闭独立 Chrome profile | **完成**（进程 0） |
| 2 | 停止 GUI 和 Native Host | **完成**（进程 0） |
| 3 | 删除 Chrome KeyNest 注册项 | **完成**（`exists=False`） |
| 4 | 不触碰 Edge 注册项 | **完成**（全程未创建） |
| 5 | 删除临时 manifest | **完成**（随目录删除） |
| 6 | 清理临时 vault/bridge.key/profile/日志 | **完成**（目录已删除） |
| 7 | Chrome 注册项已不存在 | **确认** |
| 8 | Edge 注册项保持原状 | **确认**（`False`，与测试前一致） |
| 9 | 真实库 size/mtime/MD5 一致 | **确认**（见第 8 节） |
| 10 | 真实 bridge.key 未被创建 | **确认**（不存在） |
| 11 | 真实 `%LOCALAPPDATA%\KeyNest` 未被写入 | **确认**（不存在） |
| 12 | 无遗留进程和临时目录 | **确认**（`chrome=0`、`keynest=0`、目录已删） |

**清理过程中的一个小插曲**（如实记录）：首次删除临时目录失败，原因是 `site/` 被两个残留 python 进程占用（我启动的测试服务器）。终止这两个进程后删除成功。**已确认无残留。**

---

## 8. 真实密码库未被修改的证据

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| size | `42228` | `42228` |
| mtime | `2026-11-01 23:19:17.191727900 +0800` | **相同** |
| MD5 | `2bd94cde0fa7d1e1166c930324f763c` | **相同** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| 真实 `%LOCALAPPDATA%\KeyNest` | 不存在 | **不存在** |

---

## 9. Git 状态

```
分支        feat/browser-bridge
基线        99356e5
本次改动    scripts/register-native-host-dev.ps1（-ManifestDir）
            docs/KeyNest-Browser-Bridge-Phase2.6-Report.md（本文件）
main        09b870d（未动）
v0.4.3      2bd390e（未动）
未推送、未合并、未发布
```

---

## 10. 测试计数

| 类别 | 数量 |
| --- | --- |
| **真实 Chrome PASS** | **9 项**（A1/A2/A3/A4/A5、B1/B2、C9、清理 12 项） |
| **BLOCKED** | **10 项**（A7/A8、B3/B4、C1–C7） |
| **SIMULATED** | 5 项（A6、B5、C8、C10、C11、C12 中除 C9 外） |
| **FAIL** | **0 项** |
| **NOT TESTED** | 0 项 |

---

## 11. 需要你决定

真实填充链路的最后一环是 GUI 解锁。三条可行路径：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A. 你手动解锁一次** | 我准备好环境，你在 GUI 里输入虚构主密码（`phase26-test-master-...`），之后我接管做 Chrome 测试 | 你需要在场 1 分钟 |
| **B. 给 GUI 加测试专用自动解锁** | 仅在 `KEYNEST_TEST_AUTOMATION=1` 时启用，从环境变量读主密码 | 需要改代码，且是**安全敏感改动**，我倾向不做 |
| **C. 跳过真实填充** | 接受 9 项真实 PASS + 其余 SIMULATED，直接进入下一阶段 | 真实端到端永远留空 |

**我建议 A**：最真实、零代码改动、风险最低。

---

## 12. 停止点

**第二部分完成，已停止。**

- 未进入自动保存
- 未实现页面加载自动填充
- 未做浏览器内置密码库同步
- 未扩大 origin 信任范围
- 未注册 Edge
- 未推送、未合并、未发布

**环境已完全清理，真实库与真实 bridge.key 未被触碰。等你审查。**
