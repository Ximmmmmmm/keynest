# KeyNest 验收夹具使用说明

> 面向开发者。这套脚本用来在**真实 Chrome + 真实 GUI + 真实 Native Host** 上跑端到端验收。
> 它不参与发布产物，也不是单元测试的替代品——它只回答一个问题：
> **在用户机器上真的能跑通吗。**

---

## 1. 为什么要有这一套

阶段 2.6–2.7.2 的验收脚本每次都是临时写的、跑完就删，代价是：

- 同样的坑反复踩（GUI 解锁在阶段 2.6 被标 BLOCKED，直到 2.7.4 才解开）
- 报告里的数字无法复现
- 每次回归都要从头再写一遍

所以从阶段 2.7.4 起，夹具随仓库入库，任何人随时可以重跑。

---

## 2. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Chrome | 已安装，路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe` | 路径写死在 `lib/env.mjs` 的 `CHROME` 常量，换路径改一处 |
| Rust | `cargo` 在 `C:/Users/<你>/.cargo/bin/cargo.exe` | 同样在 `lib/env.mjs` 的 `seedVault` 里 |
| 已构建 | `cargo build -p keynest-egui -p keynest-bridge --bins --examples` | 脚本用 `rust/target/debug/` 下的 exe |
| Node | ≥ 22（用到内置 `WebSocket`） | |
| 桌面会话 | **必须是交互式会话**（`WinSta0`） | GUI 解锁靠真实输入事件，无桌面时无法执行 |

最后一条是硬性的：GUI 解锁通过 `SendInput` + 鼠标事件完成，在服务会话（session 0）里没有可交互桌面。

---

## 3. 跑一次完整验收

```bash
node test/acceptance/run.mjs
```

输出示例：

```
=== 阶段 2.7.4 · 真实 Chrome 验收 ===
临时目录   C:\Users\XIM\AppData\Local\Temp\kn274
真实库     42228 B md5=2bd94cde0fa7d1e1166c930324f763cf
注册项(前) chrome=false edge=false

  T0     PASS  GUI 解锁并启动桥接（bridge.key 生成） — unlock=CLICKED_SUBMIT
  T2     PASS  Native Messaging 握手 + status（未锁定）
  ...
=== 结果 === PASS 17 / FAIL 0 / 共 17
```

退出码：全部 PASS 且真实库未变 → `0`；否则 `1`。

**排错时加 `KN_KEEP=1`**，临时目录不会被删，可以直接看 Chrome/GUI 日志与 profile：

```bash
KN_KEEP=1 node test/acceptance/run.mjs
```

结果同时写到 `test/acceptance/.out/phase274.json`（已 gitignore）。

---

## 4. 它到底动了什么

| 对象 | 动作 | 清理 |
| --- | --- | --- |
| `%TEMP%\kn274\` | 新建：临时库、Chrome profile、manifest、站点证书、日志 | **全程删除** |
| `KEYNEST_DATA_DIR` | 指向上面的 `data/` | 只影响本脚本拉起的进程 |
| `HKCU\...\Chrome\NativeMessagingHosts\com.keynest.bridge` | 注册（指向临时 manifest） | **必删**，并在结束时复查为 `False` |
| Edge 注册项 | **全程不碰** | — |
| 真实 `vault.dat` / `bridge.key` | **只读指纹**（size/mtime/md5）做前后对比 | 不修改 |

**脚本会在结束时断言真实库未变，变了就以非零码退出**——这不是装饰，是防止"测试偷偷改了用户数据"。

---

## 5. 结构

```
test/acceptance/
├── run.mjs            16–17 项验收，串起整条链路
├── gui-unlock.ps1     GUI 解锁的真实输入自动化
└── lib/
    ├── cdp.mjs        零依赖 CDP 客户端（Node 22+ 自带 WebSocket）
    ├── env.mjs        临时环境、Host 注册、进程清理
    └── site.mjs       两个 origin 的 HTTPS 测试站点
```

### 5.1 为什么不用 puppeteer

puppeteer 会下载一整套 Chromium（约 200MB）。而我们要测的是**用户机器上真实的那个 Chrome**。
两种做法得到的结论不一样，用自带 Chromium 还会让报告里写的版本号失去意义。

### 5.2 扩展加载方式

`Extensions.loadUnpacked` —— 走**真实 `chrome://extensions` 通路**。
不用命令行 `--load-extension`：Chrome 137+ 已移除该支持，继续用会让验收结果失真。

---

## 6. 两套消息上下文（最容易踩的坑）

扩展 SW 用 `classifySender` 按 `sender.id` + `sender.url` 分三类：

| 来源 | 判据 | 允许的消息 |
| --- | --- | --- |
| `popup` | URL 是 `chrome-extension://<id>/popup/popup.html` | `query` / `authorize-fill` |
| `content` | `sender.tab` 存在且 URL 不是扩展页 | `redeem-fill` |
| `unknown` | 其余，**包括 SW 自己发给自己的消息** | 全部拒绝 |

所以：

- **特权消息**必须从 popup.html（作为真实标签页打开）发出；
- **兑换消息**必须从 content script 的**隔离世界**发出——
  用 CDP 的 `executionContextId` 精确切进去，判据是 `auxData.type === 'isolated'` 且 `name === 'KeyNest'`。
  主世界里根本没有 `chrome.runtime`。

在 SW 里直接 `sendMessage` 给自己会拿到 `PRIVILEGED_ONLY` / `CONTENT_ONLY`。
**这不是缺陷，是设计正确的来源模型**——SW 自己发的消息本就不该被当成用户操作。

```js
// 正确：先 Runtime.enable，再从事件里拿 contextId
const ctxPromise = awaitIsolatedWorld(cdp, page.sessionId);
await cdp.send('Runtime.enable', {}, page.sessionId);
const contentCtx = await ctxPromise;
await page.call(`chrome.runtime.sendMessage({...})`, contentCtx);
```

---

## 7. GUI 解锁：三个必须处理对的 Windows 细节

`gui-unlock.ps1` 把这三个坑都处理了。要改这个脚本，先读一遍，否则会退化成
「脚本说点了，界面没反应」或者「密码少一位，只显示主密码错误」。

| # | 坑 | 现象 | 解法 |
| --- | --- | --- | --- |
| 1 | **Windows 前台锁** | 后台进程的 `SetForegroundWindow` 被忽略，鼠标打到别的窗口 | `AttachThreadInput` 接到当前前台窗口的输入队列，再 `SetForegroundWindow` + `SwitchToThisWindow`，重试 3 次 |
| 2 | **egui 空闲节流重绘** | 点完输入框立刻打字，**第一个字符被丢掉** → 少一位 → 「主密码错误」 | 点击后等 900ms 让 egui 完成一帧（空闲时按 500ms 节流） |
| 3 | **虚拟键需要扫描码** | `keybd_event(vk, 0, ...)` 对部分字符不可靠 | 改 `SendInput` + `KEYEVENTF_UNICODE`，按字符注入，与键盘布局无关 |

**成功判据不看脚本返回值，而看 `bridge.key` 是否出现**：

```js
const unlock = unlockGui(dirs, MASTER);
const keyed = await waitFile(path.join(dirs.data, 'bridge.key'), 15000);
```

`bridge.key` 只在「解锁成功 → `BridgeService::start()`」之后才被创建，
是产品自身的副作用，无法伪造。

### 坐标

`gui-unlock.ps1` 的默认坐标按 `1180×760` 客户区实测：

| 控件 | 客户区坐标 |
| --- | --- |
| 主密码输入框 | `(592, 382)` |
| 解锁按钮 | `(592, 440)` |

窗口尺寸变了要跟着改（`-FieldX/-FieldY/-ButtonX/-ButtonY`）。

---

## 8. 测试站点

`lib/site.mjs` 启两个 HTTPS 实例：

| 站点 | URL | 用途 |
| --- | --- | --- |
| A | `https://127.0.0.1:9445/` | 主站：登录框 + 同源 iframe + 跨站 iframe→B |
| B | `https://localhost:9446/` | 跨站源 |

`127.0.0.1` 与 `localhost` 在 origin 语义上是**不同 host**，所以能测跨站查询与跨 origin 授权。
另有 `http://127.0.0.1:9447/`（由 `run.mjs` 临时起）用于验证 HTTP 拒绝。

自签证书由 `ensureCert` 用 openssl 生成，SAN 同时含 `DNS:localhost` 与 `IP:127.0.0.1`。
Chrome 用 `--ignore-certificate-errors` 启动。

---

## 9. 库夹具

`seedVault` 调 `rust/keynest-core/examples/seed_site.rs`，写入两条**虚构**条目：

| 条目 | origin | 用途 |
| --- | --- | --- |
| `kn-test-user` | 参数指定（默认 `https://127.0.0.1:9445`） | 主站填充 |
| `other-origin-user` | `https://localhost:9446/` | 验证精确 origin 匹配（不串站） |

不复用 `write` 示例的原因：它的网址写死 `https://rust.test`，对不上验收站点，
`query` 会返回 0 条，测试就白跑了。

---

## 10. 加新用例

在 `run.mjs` 的 `try` 块里按现有模式加一段：

```js
const r = await popup.call(`chrome.runtime.sendMessage({ type: 'status' })`);
record('T11', '用例标题', r && r.ok ? 'PASS' : 'FAIL', JSON.stringify(r));
```

约定：

- `record` 的第一个参数是用例编号，报告里直接引用它；
- **note 里写证据**（返回体、计数、DOM 值），别只写「ok」——报告要能自证；
- 需要新 origin 时改 `lib/site.mjs`，别在 `run.mjs` 里起临时 server（HTTP 那个是例外，它只验拒绝路径）。

---

## 11. 当前覆盖与未覆盖

**覆盖**（详见 `docs/KeyNest-Browser-Bridge-Phase2.7.4-Report.md`）：
GUI 解锁、status、query 不含密码、空闲不超时、跨 origin 查询、100 并发兑换、
重复兑换、真实填充、username 传递、Tab 关闭失效、主世界无 storage、错误 entryId、HTTP 拒绝。

**未覆盖**（如实）：

| 项 | 原因 |
| --- | --- |
| SW 休眠唤醒 | MV3 SW 生命周期由浏览器控制，无官方 API 强制停止 |
| 5.0s TTL 精确边界 | CDP 往返误差 ±1s，无法稳定命中 |
| 同源 iframe 填充 | 结构性不支持（`all_frames:false` + `frameId=0`） |
| popup 的 DOM 点击绑定 | popup 作为标签页打开时 `tabs.query({active:true})` 解析到它自己 |
| Edge | 只测 Chrome |
