# 真实 Chrome 测试准备清单（阶段 2.7.1）

> **本文件是准备清单与脚本草稿。未执行、未注册、未创建任何目录。**
> 执行前必须获得人工批准。

---

## 0. 铁律

| # | 规则 |
| --- | --- |
| 1 | 先设 `KEYNEST_DATA_DIR`，**再启动 Chrome**，最后用**同一变量**启动 GUI |
| 2 | Chrome 启动 Native Host 时，Host 继承的是 **Chrome 进程的环境**，不是当前 shell |
| 3 | 只注册 Chrome 一条 HKCU 项，**不注册 Edge** |
| 4 | 全程使用虚构主密码与虚构条目，不碰真实库 |
| 5 | 测试后必须 `-Uninstall` 并删除临时目录 |
| 6 | 真实库 md5 与真实 `bridge.key` 存在性，测试前后各记录一次 |

---

## 1. 环境准备（脚本草稿，未执行）

```powershell
# ---- 0) 前置检查（只读）----
$REAL = "$env:APPDATA\KeyNest\vault.dat"
if (Test-Path $REAL) {
    $before = (Get-FileHash $REAL -Algorithm MD5).Hash
    Write-Host "真实库 md5(前): $before"
}
Write-Host "真实 bridge.key: $(Test-Path "$env:LOCALAPPDATA\KeyNest\bridge.key")"

# ---- 1) 建临时目录 ----
$R = Join-Path $env:TEMP "KeyNest-Phase2.7-Test"
foreach ($d in 'data','manifest','bin','profile','site-a','site-b','logs') {
    New-Item -ItemType Directory -Path (Join-Path $R $d) -Force | Out-Null
}

# ---- 2) 关键：先设环境变量（必须在启动 Chrome 之前）----
$env:KEYNEST_DATA_DIR = Join-Path $R 'data'
Write-Host "KEYNEST_DATA_DIR = $env:KEYNEST_DATA_DIR"
```

> ⚠️ **这一步顺序错了整个测试就废了**：如果先启动 Chrome 再设变量，
> Chrome 启动的 Host 会读不到变量 → 用默认目录 → 与 GUI 读到的目录不同 → 握手失败。

---

## 2. 本地 HTTPS 站点（两个 origin）

| 站点 | 端口 | 用途 |
| --- | --- | --- |
| A | `https://127.0.0.1:9445/` | 主测试页：登录框 + **同源 iframe**（`/iframe`）+ **跨站 iframe**（指向 B） |
| B | `https://localhost:9446/` | 跨站源：独立登录框 |

**自签证书必须含两个 SAN**：

```
subjectAltName = DNS:localhost, IP:127.0.0.1
```

**为什么两个 origin 不同**：`127.0.0.1` 与 `localhost` 是不同 host，
加不同端口，origin 必然不同。这是最省事的跨站构造方式，无需外网。

### 页面 A 结构

```html
<h1>Phase 2.7 Test A</h1>
<form>
  <input type="text" id="user" name="user">
  <input type="password" id="pass" name="pass">
</form>

<!-- 同源 iframe：用于验证「当前不支持 iframe 填充」的能力边界 -->
<iframe id="same" src="/iframe" width="400" height="120"></iframe>

<!-- 跨站 iframe：用于验证「跨站 frame 拿不到密码」 -->
<iframe id="cross" src="https://localhost:9446/" width="400" height="120"></iframe>
```

### 页面 B 结构

```html
<h1>Phase 2.7 Test B</h1>
<form>
  <input type="text" id="user-b">
  <input type="password" id="pass-b">
</form>
```

---

## 3. 临时密码库

```powershell
# 用虚构主密码创建（密码只在执行时输入，不写入任何文件）
# 条目：url = https://127.0.0.1:9445/  username = phase27-test-user  password = 虚构值
```

**必须记录**：vault 路径、大小、mtime、条目 ID（**不记录密码**）。

---

## 4. 注册 Native Host（仅 Chrome 一条）

```powershell
.\scripts\register-native-host-dev.ps1 `
  -HostExe "$R\bin\keynest-native-host.exe" `
  -ChromeId "<从 chrome://extensions 读到的开发 ID>" `
  -ManifestDir "$R\manifest"
```

**不传 `-EdgeId`**。

---

## 5. 启动顺序（严格）

```powershell
# 1) 环境变量已设（第 1 节）
# 2) 启动 Chrome（继承变量）
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
  "--user-data-dir=$R\profile", `
  "--remote-debugging-port=9338", `
  "--remote-allow-origins=*", `
  "--ignore-certificate-errors", `
  "--no-first-run", "--no-default-browser-check", "about:blank"

# 3) 用 CDP Extensions.loadUnpacked 加载扩展
#    （--load-extension 在 Chrome 137+ 已失效，必须用 CDP）
#    记录返回的扩展 ID，与 manifest 的 allowed_origins 必须一致

# 4) 用**同一** KEYNEST_DATA_DIR 启动 GUI
```

---

## 6. 七项测试的执行步骤

### T1 · 跨站 iframe 拒绝

| 项 | 内容 |
| --- | --- |
| **步骤** | 1. 打开 A，等**两个 iframe 都 load 完成**<br>2. 点扩展 → 只应列出 A 的条目<br>3. 执行填充<br>4. 用 CDP 分别读主 frame 与两个 iframe 的 `input.value` |
| **PASS** | 主 frame 被填充；**同源 iframe 与跨站 iframe 都为空** |
| **证据** | 三个 frame 的 `frameId` / `documentId` / `url`；三个 `input.value` 长度 |
| **假阳性** | iframe 未加载完就读值 → 空值误判为"拒绝"。**必须先等 `load`** |
| **层** | `REAL_CHROME` + `REAL_GUI` |

### T2 · 同源 iframe 不支持填充（能力边界）

| 项 | 内容 |
| --- | --- |
| **步骤** | 向同源 iframe 的 frameId 发 `prepare-fill`（模拟越权尝试） |
| **预期** | 拒绝（`ORIGIN_MISMATCH` 或 `NO_CONTENT_SCRIPT`——content script 只注入主 frame） |
| **证据** | `getAllFrames` 返回的 frameId 列表；content script 是否存在于该 frame |
| **说明** | 这是**能力边界**，不是缺陷。记录即可 |
| **层** | `REAL_CHROME` |

### T3 · 导航后旧授权失效

| 子场景 | 步骤 | 预期 |
| --- | --- | --- |
| 同 origin 跳转 | A `/` → `/other`，用旧 nonce 兑换 | 拒绝（`DOCUMENT_CHANGED` 或 `AUTH_REJECTED`） |
| 跨 origin 跳转 | A → B，用旧 nonce 兑换 | 拒绝 |
| **SPA pushState** | A 执行 `history.pushState({},'','/spa')`，**不换文档** | **不失效**（documentId 未变，同一文档仍可填） |

| 项 | 内容 |
| --- | --- |
| **证据** | 三个时刻的 `getFrame().documentId`；兑换返回码 |
| **假阳性** | 把 `pushState` 当成导航 → 误判"SPA 失效"。**必须断言 documentId 未变** |
| **层** | `REAL_CHROME` |

### T4 · 5 秒 TTL 真实过期

| 项 | 内容 |
| --- | --- |
| **步骤** | 1. 签发授权，记 `t0 = performance.now()`<br>2. 在 4.9s 兑换 → 成功<br>3. 重新签发，5.0s 兑换 → 失败<br>4. 重新签发，5.1s 兑换 → 失败 |
| **证据** | 每次实际耗时（毫秒）、返回码 |
| **假阳性** | CDP `evaluate` 往返延迟跨过边界 → 误判。**容差 ±100ms，并记录实际值** |
| **层** | `REAL_CHROME`（真实 SW 单调时钟） |

> ⚠️ 本轮已把 TTL 改成 `performance.now()`，所以**系统时间调整不再影响**。
> 若发现 4.9s 失败而 5.1s 成功，说明修复没生效，必须停测排查。

### T5 · Tab 关闭后授权失效

| 项 | 内容 |
| --- | --- |
| **步骤** | 1. 签发授权<br>2. `chrome.tabs.remove(tabId)`<br>3. **确认 tab 已消失**（`tabs.get` 抛错）<br>4. 用旧 nonce 兑换 |
| **PASS** | `AUTH_REJECTED` |
| **证据** | 关闭前后的 tab 列表；兑换码 |
| **假阳性** | 兑换先于关闭完成 → PASS 但测的不是关闭路径。**必须确保兑换在关闭之后** |
| **层** | `REAL_CHROME` |

### T6 · Service Worker 休眠与唤醒

| 项 | 内容 |
| --- | --- |
| **步骤** | 1. 签发授权<br>2. 记录 SW target 存在<br>3. 用 `chrome.debugger` 或等待空闲超时让 SW 停止<br>4. **用 CDP `/json/list` 确认 SW target 消失**<br>5. 发消息唤醒<br>6. 用旧 nonce 兑换 |
| **PASS** | `AUTH_REJECTED`；且 `typeof chrome.storage === 'undefined'` |
| **证据** | SW target 出现/消失的时间点截图或列表；兑换码 |
| **判定** | **若无法可靠证明 SW 真正停止 → 标 `BLOCKED`，不得标 PASS** |
| **层** | `REAL_CHROME`（**最难可靠执行**） |

**为什么可能 BLOCKED**：

- MV3 SW 的停止时机由浏览器控制，`chrome.debugger` 能 `Target.closeTarget` 但 Chrome 可能立即重建
- 没有官方 API 强制 SW 停止
- 只能"等空闲超时"（30 秒），且期间任何事件都会重置计时

**可接受的替代证据**（若 SW 测试 BLOCKED）：

- `NODE_SIMULATED`：新 `AuthStore` 实例看不到旧记录（已有测试）
- 代码审查：无任何持久化写入（全仓 `grep`）

### T7 · 并发兑换只有一次成功

| 项 | 内容 |
| --- | --- |
| **步骤** | 1. 签发授权<br>2. **在 SW 上下文内**用 `Promise.all` 发起 100 个 `redeem-fill`<br>3. 统计成功数与 GUI 侧 `vault.fill` 调用次数 |
| **PASS** | 成功 1 / 拒绝 99；`fill` 只被调用 1 次 |
| **证据** | 成功/失败计数；GUI 日志中的 fill 次数 |
| **假阳性** | 100 个 `sendMessage` 可能被 Chrome 串行化 → 测不出竞态。**应在 SW 内直接调函数** |
| **层** | `REAL_CHROME` + `REAL_GUI` |

---

## 7. 清理

```powershell
# 1) 关闭 Chrome（只关测试 profile 的进程）
# 2) 关闭 GUI 与 Host
# 3) 卸载注册项
.\scripts\register-native-host-dev.ps1 -Uninstall -ManifestDir "$R\manifest"
# 4) 删除临时目录
Remove-Item $R -Recurse -Force
# 5) 复核
#    - Chrome / Edge 注册项均为 False
#    - 真实库 md5 与步骤 0 记录一致
#    - 真实 bridge.key 仍不存在（或未被修改）
#    - 无遗留进程
```

---

## 8. 证据分类总表

| 测试 | REAL_CHROME | REAL_NATIVE_HOST | REAL_GUI | NODE_SIMULATED | UNIT_TEST |
| --- | --- | --- | --- | --- | --- |
| T1 跨站 iframe | ✔ | ✔ | ✔ | ✔ | — |
| T2 同源 iframe 边界 | ✔ | — | — | — | — |
| T3 导航后失效 | ✔ | ✔ | ✔ | ✔ | — |
| T4 TTL 过期 | ✔ | — | — | ✔ | ✔ |
| T5 Tab 关闭 | ✔ | — | — | ✔ | — |
| T6 SW 休眠 | ✔ 或 **BLOCKED** | — | — | ✔ | — |
| T7 并发兑换 | ✔ | ✔ | ✔ | ✔ | — |
