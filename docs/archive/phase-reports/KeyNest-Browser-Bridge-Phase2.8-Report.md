# KeyNest 阶段 2.8 报告 · 统一扩展架构（模块系统 / 权限清单 / 配置中心）

> 基线 `0c0a960`（阶段 2.7.4）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：**真实 Chrome 156.0.8078.80** + 真实 Native Host + 真实 GUI + 临时密码库
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 单体 SW → 模块化 | **378 行 → 47 行**，行为一行未改 |
| 既有链路回归 | **真实 Chrome 19/19 全 PASS**（2.7.4 的 17 项 + 新增 2 项） |
| 单元/集成测试 | **182 通过**（原 91 + 新增 91） |
| 配置中心 | 已落地，**secret schema 注册不进来** |
| 权限清单 | 已落地，能反推 manifest 权限并发现膨胀 |
| 设置页 | 新增，真实 Chrome 里渲染正常 |
| 产品缺陷 | 本轮**发现并修掉 1 个**（见 §5） |

**这一阶段没有加任何新功能。** 它做的是让后面十几个功能加得进去、
加得安全、加得可审计。

---

## 1. 为什么先立骨架而不是先加功能

任务要求明确写了「优先建设统一的扩展架构、权限管理、模块系统、配置中心和安全通信机制，
避免功能重复、代码堆积和权限滥用」。

当前状态：`service-worker.js` 是一个 378 行单体，Native 端口、授权状态机、
消息路由、业务逻辑全在一起。如果直接开始加"广告过滤"，只有两条路：

| 路 | 半年后的样子 |
| --- | --- |
| 继续往单体里加 | 没人敢改；权限说不清谁用了什么；一个模块抛异常能把整个消息循环搞挂 |
| 先拆骨架再填功能 | 加功能 = 写一个模块文件 + 一行注册；权限可反推、可审计 |

选了后者。

---

## 2. 重构前后

### 2.1 行数

| 文件 | 重构前 | 重构后 | 说明 |
| --- | --- | --- | --- |
| `background/service-worker.js` | 378 | **47** | 只剩建宿主 + 挂 onMessage |
| `lib/host.js` | — | 276 | Native 端口 + 来源门禁 + 生命周期接线 |
| `lib/modules.js` | — | 246 | 注册表：校验、分派、权限求和 |
| `lib/modules/vault.js` | — | 211 | 原 SW 的业务逻辑，**搬家不改逻辑** |
| `lib/config.js` | — | 337 | 配置中心 |
| `lib/permissions.js` | — | 177 | 能力 → manifest 权限映射 |
| `lib/errors.js` | — | 34 | 统一错误基类 |
| `lib/modules/registry.js` | — | 58 | 模块管理（设置页后端） |
| `options/options.js` | — | 154 | 设置页 |

### 2.2 搬家原则

**行为等于搬家**：一行逻辑都不改，只换位置与依赖注入方式。

阶段 2.6–2.7.4 在真实 Chrome 里验证过的每一条不变式都原样保留：

1. 只有 `host.js` 能 `connectNative`
2. 密码只在模块局部变量里短暂存在
3. 填充授权是一次性、短时效、绑定 tab/frame/origin/entry 的状态机

改动只有两种：

- 依赖从"直接读全局 `chrome.*`"改成"由宿主注入"，方便在 node 里跑
- 消息类型集中声明，而不是散在 `if` 链里

**验收网**：2.7.4 建立的 17 项真实 Chrome 验收就是照着这些行为写的。
搬家时任何一条改变，那 17 项都会挂。

---

## 3. 新增的四个基础件

### 3.1 模块系统（`lib/modules.js`）

模块声明 id / title / requires / config / handlers，注册时全部校验完：

| 校验项 | 时机 | 失败行为 |
| --- | --- | --- |
| 模块 id 形状 | 注册 | 抛 `BAD_ID` |
| 能力名是否在 `CAPABILITIES` 里 | 注册 | 抛 `UNKNOWN_CAPABILITY` |
| 消息类型形状 | 注册 | 抛 `BAD_MESSAGE_TYPE` |
| 消息类型全局唯一 | 注册 | 抛 `DUPLICATE_MESSAGE`，**且不留半截注册** |
| 配置 schema | 注册 | 抛 `ConfigError` |

分派时做三件事：

1. 未知类型 → `UNKNOWN_TYPE`（不静默，否则调用方只会超时）
2. 模块已禁用 → `MODULE_DISABLED`（handler 不执行）
3. handler 抛错 → 捕获并只回 `e.code`，**不回 `e.message`**

第 3 条是有意的：`e.message` 可能带路径、条目名之类不该过桥的东西。

**关于消息类型允许不带点**：现有线上协议是 `status` / `query` / `authorize-fill`，
它们已经在真实 Chrome 里验证过、content script 里也是硬编码的字符串。
为了"结构好看"去改线上协议，只有风险没有收益，所以正则允许 `name` 与 `namespace.action` 两种形状。

### 3.2 配置中心（`lib/config.js`）

三条硬规则：

**① schema 就是边界。** 未声明的键读不到也写不进。没有 schema 的配置就是一堆
`undefined`——模块读到 `undefined` 当成 `false`，于是"用户明明开了却像没开"。

**② 带 secret 的 schema 根本注册不进来。**

```js
config.registerModule('x', { pw: { type: 'string', default: '', secret: true } });
// → ConfigError: SECRET_FORBIDDEN
```

不是"提醒你别这么写"，而是注册失败。密码、token、主密码永远不会因为某个模块
图省事而被写进浏览器存储。

**③ 按模块分命名空间。** 后端键名形如 `keynest.cfg.<moduleId>`。
模块 A 与 B 都写 `enabled` 不会互相踩。

存储后端默认是**内存**，不引入 `storage` 权限。这是刻意的取舍：
扩展当前连 `chrome.storage` 都没有，这正是它「不持久化任何敏感状态」的一部分。
要持久化设置就得加权限，那是一次需要单独审查的安全决策，
不该被顺手塞进架构重构里。

### 3.3 权限清单（`lib/permissions.js`）

`CAPABILITIES` 是穷举的，模块 `requires` 里写清单外的名字直接失败。

两个核心能力：

```js
requiredManifestPermissions(modules);
// → { permissions: ['activeTab', 'nativeMessaging', ...], hostPermissions: ['https://*/*'] }

diffManifest(manifestJson, modules);
// → { missing, unused, missingHosts, ok }
```

`unused` 非空就说明**权限膨胀**——manifest 声明了但没有任何模块在用。
这个检查的价值在于：权限只增不减是这类扩展最常见的腐化方式。

**当前实测**（真实 Chrome，设置页显示）：

```
模块实际需要：activeTab、nativeMessaging、scripting、webNavigation
需要的站点范围：https://*/*
```

与 manifest 完全一致，`diffManifest().ok === true`。

### 3.4 消息来源门禁（`lib/host.js`）

| 来源 | 判据 | 例 |
| --- | --- | --- |
| `popup` | URL 在特权页面白名单里 | `popup/popup.html`、`options/options.html` |
| `content` | `sender.tab` 存在且 URL 不是扩展页 | 网页里的 content script |
| `unknown` | 其余 | **包括 SW 自己发的消息** |

白名单穷举（`PRIVILEGED_PAGES`），没列进去的扩展页面一律 unknown。
这个"不方便"是刻意的：新增特权入口必须是一次显式决定。

门禁表 `KIND_REQUIREMENT` 是**冻结**的（`Object.freeze`）——改它需要改代码，
不能运行时篡改。它同时也是攻击面清单：一眼能看完谁能发什么。

---

## 4. 真实 Chrome 验收（19/19 PASS）

在 2.7.4 的 17 项基础上新增 2 项：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T10** | 设置页渲染出模块列表（含权限自述） | **PASS** | `cards:2`，`error:null`，权限自述与 manifest 一致 |
| **T10b** | 核心模块标记为不可关闭 | **PASS** | `["核心模块","核心模块"]` |

**原有的 17 项全部保持 PASS**，包括最容易受重构影响的：

- T7 真实 SW 内 100 并发兑换只成功 1 次
- T7e 携带 username 的授权填充
- T5e Tab 关闭后旧授权失效
- T2 status 的线上形状 `{ok:true, data:{...}}`

### 4.1 T2 的线上形状为什么必须验

重构时我把 handler 的返回值改成了「直接返回响应体，不再包一层 `{ok:true,data}`」，
于是 `status` 的返回值从 `{ok:true, data:{locked,...}}` 变成了纯 payload。
**真实 Chrome 验收的 T2 立刻抓到了这个回归**（`data` 变 `undefined`）。

修复：`status` 的 handler 显式包装成 `{ok:true, data: await request(...)}`。
这条现在有单元测试守着（`tests/host.test.js` 的 "status 谁都问得到"）。

---

## 5. 本轮发现并修复的产品缺陷

### 缺陷：`request()` 同步抛错时调用方 await 不到

| 项 | 内容 |
| --- | --- |
| **位置** | `lib/host.js` 的 `createNativePort().request` |
| **现象** | Host 没装时 `connectNative` 同步抛错，`await request(...)` 不会 reject——异常在 `await` 之前就冒出来了 |
| **等级** | **中** |
| **影响** | 调用方只能靠外层 `try/catch` 兜，极易漏掉；漏掉就是"点了没反应" |
| **修复** | `request` 声明成 `async`，同步抛错自动变成 rejected promise |
| **测试** | `tests/host.test.js` 的 "connectNative 抛错时返回 NATIVE_HOST_MISSING" |

这个缺陷在重构前就存在（原 `service-worker.js` 里也是同步 `connect()`），
只是原来的调用链恰好都有外层 try/catch 兜着。抽出来单独测时暴露了。

---

## 6. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **182** | 原 91 + 新增 91 |
| 真实 Chrome | **19** | 全 PASS |
| Rust | **241** | 本轮未改 Rust |

新增测试分布：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/config.test.js` | 21 | schema 校验、secret 拒绝、命名空间、脏数据丢弃 |
| `tests/modules.test.js` | 26 | 注册校验、分派、错误隔离、权限求和与差异 |
| `tests/host.test.js` | 30 | Native 端口生命周期、来源门禁、生命周期接线 |
| `tests/registry-module.test.js` | 14 | 设置页接口、核心模块不可关闭 |

### 6.1 测试里刻意遵守的两条

**① 失败路径比成功路径多。** 182 项里绝大部分是 `FAIL-SAFE:` 开头。
成功路径写在代码里就能看出来，失败路径才是重构会悄悄破坏的东西。

**② 测协议形状，不测实现细节。** T2 那条断言的是
`{ok:true, data:{locked,...}}` 这个线上形状，不是"handler 返回了什么"。
正因如此它才能抓到 §4.1 的回归。

---

## 7. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `background/service-worker.js` | 重写 | 378 → 47 行 |
| `lib/host.js` | 新增 | Native 端口 + 门禁 + 接线 |
| `lib/modules.js` | 新增 | 注册表 |
| `lib/modules/vault.js` | 新增 | 原 SW 业务逻辑搬家 |
| `lib/modules/registry.js` | 新增 | 设置页后端 |
| `lib/config.js` | 新增 | 配置中心 |
| `lib/permissions.js` | 新增 | 权限清单 |
| `lib/errors.js` | 新增 | 统一错误基类 |
| `options/{options.html,options.js,options.css}` | 新增 | 设置页 |
| `manifest.json` | 改 | `options_ui` 指向新页面；版本 0.5.0 → 0.6.0 |
| `package.json` | 改 | 版本同步 |
| `tests/{config,modules,host,registry-module}.test.js` | 新增 | 91 项测试 |
| `docs/browser-extension-architecture.md` | 新增 | 架构文档 |
| `test/acceptance/run.mjs` | 改 | 加 T10 / T10b |

**没有改动 `content/`、`popup/`、`lib/{auth-store,origin,redeem,sender}.js`。**
那条链路是 2.6–2.7.4 反复验证过的，本轮一行没碰。

---

## 8. 数据保护与清理

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` | `42228` B / md5 `2bd94cde…` | **完全一致** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| `%LOCALAPPDATA%\KeyNest` | 不存在 | **不存在** |
| Chrome / Edge 注册项 | `False` / `False` | **`False` / `False`** |
| 临时目录 | — | **已删除** |
| 遗留进程 | — | **0** |

---

## 9. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **配置不持久化** | 内存后端，SW 重启回到默认值。理由见 §3.2。要持久化需单独批准 `storage` 权限 |
| 2 | **设置页开关状态不跨重启** | 同上。UI 已按"可切换"实现，接上后端即可 |
| 3 | 模块系统不是安全边界 | 它解决可维护性与可审计性；真正的边界是浏览器权限与 nonce 链路 |
| 4 | 只有 2 个模块 | 骨架完成，功能模块按后续阶段加 |
| 5 | `KIND_REQUIREMENT` 未填的类型默认 `any` | `content-ready` 这类无副作用的握手消息如此；新模块应显式声明 |
| 6 | SW 自己发的消息恒为 unknown | 设计如此，不是缺陷。验收脚本因此必须从 popup / content 上下文发消息 |

---

## 10. 停止点

**阶段 2.8 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理，无遗留进程

**下一步**：按 `docs/browser-extension-architecture.md` §10 的流程，
开始加第一个真正的功能模块（广告与跟踪器过滤），并在此过程中验证骨架是否够用。
