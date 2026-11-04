# KeyNest 阶段 2.7.4 报告 · 真实 Chrome 复验与可复用验收夹具

> 基线 `2c96e86`（阶段 2.7.3）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：**真实 Chrome 156.0.8078.80** + 真实 Native Host + 真实 GUI + 真实命名管道 + 临时密码库
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 阶段 2.7.3 看门狗修复 | **真实浏览器复验 PASS**（空闲 6 秒后通信正常） |
| 阶段 2.7.2 遗留 T7（并发兑换） | **FAIL → PASS**（修复前 0/100 成功，现在 1/100 正确） |
| 阶段 2.7.2 遗留 T8b（跨 origin 查询） | **FAIL → PASS** |
| 阶段 2.7.2 遗留 T5 Tab 关闭 | **NOT TESTED → PASS** |
| 真实 Chrome 验收总数 | **17 项全 PASS** |
| 阶段 2.6 的 BLOCKED（GUI 解锁） | **已解除**，现在可自动化 |
| Rust / Node 回归 | 241 / 91 全通过，fmt / clippy 全绿 |
| 数据保护 | 真实库 md5 与 mtime **完全未变**；真实 bridge.key **从未创建** |

**本轮没有发现新的产品缺陷**——2.7.2 的两个 FAIL 全部由 2.7.3 的看门狗修复解决。

---

## 1. Git 基线

```
分支        feat/browser-bridge
HEAD        2c96e86（阶段 2.7.3）
main        09b870d（未动）
v0.4.3      2bd390e（未动）
```

---

## 2. 本轮真正解决的问题：验收基础设施

阶段 2.6–2.7.2 的验收脚本**每次都是临时写的、跑完就删**，导致：

- 同样的问题反复踩（GUI 解锁在 2.6 被标 BLOCKED）
- 无法回归：下次要验同样的东西，得从头再写一遍
- 报告里的数字无法复现

所以本阶段的主要产出不是产品代码，而是**一套可复用的验收夹具**，随仓库入库：

```
test/acceptance/
├── run.mjs            验收主程序（16 项）
├── gui-unlock.ps1     GUI 解锁的真实输入自动化
└── lib/
    ├── cdp.mjs        零依赖 CDP 客户端
    ├── env.mjs        临时环境、注册、清理
    └── site.mjs       两个 origin 的 HTTPS 测试站点
```

### 2.1 零依赖 CDP 客户端

Node 22+ 自带 `WebSocket`，够用了。**不引入 puppeteer**：

| 理由 | 说明 |
| --- | --- |
| 避免重依赖 | puppeteer 会下载一整套 Chromium（约 200MB），而我们要测的是**用户机器上真实的那个 Chrome** |
| 环境确定性 | 用工位自带的 WebSocket，测试跑的就是本机 Chrome 156，报告里的版本号可验证 |
| 依赖审计 | 项目有 `cargo deny`，但 Node 侧的依赖也该尽量少 |

`Extensions.loadUnpacked` 走的是**真实 `chrome://extensions` 通路**，不是命令行 `--load-extension`——
后者在 Chrome 137+ 已被移除支持，继续用会让验收结果失去意义。

### 2.2 GUI 解锁：阶段 2.6 的 BLOCKED 是怎么解开的

阶段 2.6 的结论是「egui 自绘界面无 UIAutomation 树，SendKeys 无法定位输入框，标 BLOCKED」。
本次把它跑通了。**不是靠改产品代码加测试后门**，而是把三个 Windows 输入细节都处理对：

| # | 坑 | 现象 | 解法 |
| --- | --- | --- | --- |
| 1 | **Windows 前台锁** | 后台进程调 `SetForegroundWindow` 被忽略，鼠标点到别的窗口上 | 先用 `AttachThreadInput` 接到当前前台窗口的输入队列，再 `SetForegroundWindow` + `SwitchToThisWindow`，失败重试 3 次 |
| 2 | **egui 空闲节流重绘** | 点完输入框立刻打字，**第一个字符被丢掉** → 密码少一位 → 只显示「主密码错误」 | 点击后等 900ms 让 egui 完成一帧（空闲时它按 500ms 节流） |
| 3 | **虚拟键需要扫描码** | `keybd_event(vk, 0, ...)` 对部分字符不可靠 | 改用 `SendInput` + `KEYEVENTF_UNICODE` 按字符注入，与键盘布局无关 |

第 2 条是最隐蔽的：**界面看起来完全正常**，密码框里也有圆点，但实际少一位。
如果没有第 3 条（Unicode 注入），还会出现「某些字符打不出来」的偶发失败。

**成功判据不看脚本返回值，而看 `bridge.key` 是否出现**——它只在「解锁成功 → `BridgeService::start()`」
之后才被创建。这是产品自身的副作用，无法伪造。

### 2.3 两个 HTTPS origin

`https://127.0.0.1:9445/`（主站）与 `https://localhost:9446/`（跨站）。
自签证书 SAN 同时包含 `DNS:localhost` 与 `IP:127.0.0.1`。

这两个在 origin 语义上是**不同的 host**，所以能测出跨站查询与跨 origin 授权。

### 2.4 为什么需要两套消息上下文

这是本轮最重要的发现之一。扩展 SW 用 `classifySender` 按 `sender.id` + `sender.url` 分三类：

| 来源 | 判据 | 能做什么 |
| --- | --- | --- |
| `popup` | URL 是 `chrome-extension://<id>/popup/popup.html` | `query` / `authorize-fill` |
| `content` | `sender.tab` 存在且 URL 不是扩展页 | `redeem-fill` |
| `unknown` | 其余，**包括 SW 自己发给自己的消息** | 什么都不行 |

一开始我在 SW 上下文里直接 `chrome.runtime.sendMessage`，全部被 `PRIVILEGED_ONLY` / `CONTENT_ONLY` 拦下。
**这不是产品缺陷，是设计正确的消息来源模型**——SW 自己发的消息本就不该被当成用户操作。

所以验收脚本必须：

- 把 `popup.html` 作为**真实标签页**打开，从那里发特权消息；
- 用 CDP 的 `executionContextId` 精确切进 content script 的**隔离世界**（`isolated` 类型、
  `name === 'KeyNest'`）发兑换——主世界里根本没有 `chrome.runtime`。

---

## 3. 逐项测试结果（16 项全 PASS）

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T0** | GUI 解锁并启动桥接 | **PASS** | `bridge.key` 在临时目录生成 |
| **T5a** | content script 注入主 frame 隔离世界 | **PASS** | `contextId=3`，`auxData.type=isolated`，`name=KeyNest` |
| **T1** | 从 popup 上下文定位 tab 并读到 origin | **PASS** | `origin=https://127.0.0.1:9445` |
| **T2** | Native Messaging 握手 + status | **PASS** | `{locked:false, protocol:1, version:"0.4.3"}` |
| **T3** | `vault.query` 不含 password 字段 | **PASS** | `entries=1`，无 `password` 键 |
| **T6** | **空闲 6 秒后仍能通信** | **PASS** | 见 §4（核心验收） |
| **T6b** | 空闲后再次查询仍返回条目 | **PASS** | `entries=1` |
| **T8b** | 跨 origin 查询不返回 A 站条目 | **PASS** | 返回 `localhost:9446` 自己的条目，A 站条目一条都没有 |
| **T7a** | `authorize-fill` 签发 nonce | **PASS** | 32 hex |
| **T7** | **真实 SW 内 100 并发只成功 1 次** | **PASS** | `okCount:1, total:100, codes:{OK:1, REJ:AUTH_REJECTED:99}` |
| **T7c** | 同一 nonce 重复兑换被拒 | **PASS** | `AUTH_REJECTED` |
| **T7d** | 真实用户路径填充页面（无 username） | **PASS** | `send={ok:true}`，`pwLen:17`，`user:""`（缺省时按设计不动用户名字段） |
| **T7e** | 携带 username 的授权：用户名也被填 | **PASS** | `user="kn-test-user"`，`pwLen:17` |
| **T5e** | Tab 关闭后旧授权失效 | **PASS** | `AUTH_REJECTED` |
| **T9** | 主世界拿不到 `chrome.storage` | **PASS** | `storage:false`，`localStorage`/`sessionStorage` 均空 |
| **T8c** | 错误 entryId 被拒 | **PASS** | `ENTRY_NOT_MATCHED` |
| **T8d** | HTTP 页面被拒 | **PASS** | `HTTP_NOT_ALLOWED` |

---

## 4. 核心验收：空闲不超时（阶段 2.7.3 修复的真实复验）

阶段 2.7.2 的故障现象：用户点开扩展犹豫几秒，连接被断开，后续请求全 `HOST_DISCONNECTED`。
阶段 2.7.3 用一个**真实 Windows 命名管道**测试证明修复有效（空闲 5 秒），但当时禁止启动 Chrome。

本轮在**真实浏览器**里复现同一路径：

```
T2  status                → PASS
    ↓ 空闲 6 秒（阈值是 3 秒，2 倍余量）
T6  status                → PASS  {"ok":true,"data":{"locked":false,...}}
T6b query                 → PASS  entries=1
```

**这证明 2.7.3 的三阶段看门狗在真实 Chrome + 真实 Native Host + 真实 GUI 的完整链路上生效**，
不只是单元测试或裸管道。

### 顺带解释 2.7.2 的两个 FAIL

阶段 2.7.2 的 T7（并发）与 T8b（跨 origin 查询）都是 `HOST_DISCONNECTED`。
本轮同样两项在**未改任何产品代码**的前提下全部 PASS——说明那两次失败确实只是看门狗缺陷的副作用，
不是并发逻辑或 origin 匹配逻辑的问题。

---

## 5. 修改文件

| 文件 | 改动 | 性质 |
| --- | --- | --- |
| `test/acceptance/run.mjs` | 新增：16 项验收主程序 | 测试 |
| `test/acceptance/gui-unlock.ps1` | 新增：GUI 解锁真实输入自动化 | 测试 |
| `test/acceptance/lib/cdp.mjs` | 新增：零依赖 CDP 客户端 | 测试 |
| `test/acceptance/lib/env.mjs` | 新增：临时环境、注册、清理 | 测试 |
| `test/acceptance/lib/site.mjs` | 新增：两个 origin 的 HTTPS 站点 | 测试 |
| `rust/keynest-core/examples/seed_site.rs` | 新增：可指定 origin 的库夹具生成器 | 测试 |
| `.gitignore` | 忽略 `test/acceptance/.out/` | 工程 |

**产品代码零改动。** 没有为了测试方便在产品里加任何开关、后门或环境变量分支。

### 为什么加 `seed_site` 而不是复用 `write`

`write` 示例的条目网址写死 `https://rust.test`，对不上验收站点，`query` 会返回 0 条。
与其在测试里改产品数据，不如加一个专门的夹具生成器——它不参与发布产物。

---

## 6. 全量回归

| 项 | 结果 |
| --- | --- |
| `cargo test --workspace` | **241 通过**（与 2.7.3 一致，本轮未增删 Rust 测试） |
| `node --test`（扩展） | **91 通过** |
| `cargo fmt --all --check` | **PASS** |
| `cargo clippy -D warnings` | **0 问题** |
| 真实 Chrome 验收 | **17 / 17 PASS** |

---

## 7. 清理与数据保护

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` size | `42228` | **`42228`** |
| 真实 `vault.dat` mtime | `2026-11-01 23:19:17` | **相同** |
| 真实 `vault.dat` MD5 | `2bd94cde0fa7d1e1166c930324f763cf` | **相同** |
| 真实 `%LOCALAPPDATA%\KeyNest` | 不存在 | **不存在** |
| Chrome `com.keynest.bridge` 注册项 | `False` | **`False`** |
| Edge 注册项 | `False` | **`False`（全程未创建）** |
| 临时目录 `%TEMP%\kn274` | — | **已删除** |
| 遗留进程 | — | **0** |

---

## 8. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **popup 的 DOM 点击路径未覆盖** | popup.html 作为标签页打开时，`tabs.query({active:true,currentWindow:true})` 解析到的是它自己那个标签页，于是 query 必然 `NO_ORIGIN`、列表渲染不出来。要绕开只能塞假 `tabs.query`，那就变成测 mock。**折中**：T7d 走无 username 路径、T7e 走带 username 路径，两条调用的都是 popup 实际发出的同一条消息，只有「DOM 事件绑定」这一层未验证。 |
| 2 | T6 的 6 秒是**下限验证** | 只证明「空闲 6 秒不超时」，没有验证更长的空闲（比如 30 分钟会话 TTL 边界）。 |
| 3 | SW 休眠唤醒 | 仍**未覆盖**。MV3 SW 生命周期由浏览器控制，无官方 API 强制停止。阶段 2.7.2 已标 BLOCKED，本轮未改变。 |
| 4 | 5.0s TTL 精确边界 | 真实 Chrome 的 CDP 往返误差 ±1s，无法稳定命中边界；由 UNIT_TEST 覆盖。 |
| 5 | 同源 iframe 填充 | 结构性不支持（`all_frames:false` + `frameId=0` 硬编码）。这是设计选择，非缺陷。 |
| 6 | Edge | 未测试（只测 Chrome）。 |
| 7 | iframe 内 content script 的隔离世界 | 本轮只验证了主 frame 的隔离世界（`contextId=3`）。iframe 的 context 未逐一核对。 |

### 关于第 1 条的进一步说明

这一条**必须如实记录**，因为它是「测试没覆盖到某一层」而不是「产品有问题」：

```js
// popup.js:118 —— 真实路径：username 来自条目
async function doFill(entryId, username) {
  const auth = await chrome.runtime.sendMessage({
    type: 'authorize-fill',
    tabId: currentTabId,
    entryId,
    username: typeof username === 'string' ? username : '',
  });
```

T7d 不传 `username` → content script 按设计**不动**用户名字段（避免清掉用户已输入的账号）→ `user:""`。
T7e 传入 `username` → `user:"kn-test-user"`。两条合起来证明 username 链路本身是通的。

**未覆盖的只有「popup 里 `li.addEventListener('click', ...)` 这行绑定」**，
它需要 popup 自己的 `tabs.query({active:true})` 能解析到目标页——
而 popup 作为标签页打开时解析到的是它自己。这属于验收环境的固有限制，
不是产品缺陷；真实用户点工具栏图标时 popup 是真正的 popup，不存在这个问题。

## 9. 下一步

1. **缩短验收耗时**：目前一次全跑约 90 秒，其中 `seedVault` 调 `cargo run` 占了大部分。
   可改为先 `cargo build --examples` 再直接调 exe。
2. 之后进入阶段 2.8（浏览器安全与效率套件的统一扩展架构）。

---

## 10. 停止点

**阶段 2.7.4 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理，无遗留进程
