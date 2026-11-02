# KeyNest 扩展架构

> 面向开发者的扩展内部结构说明。**改任何模块前先读这一份。**
> 版本：0.6.0（阶段 2.8 立骨架）

---

## 1. 为什么要有这一层

阶段 2.8 之前，`service-worker.js` 是一个 378 行的单体：Native 端口、授权状态机、
消息路由、业务逻辑全在一起。要继续加十几个功能（广告过滤、阅读模式、截图、笔记……），
有两条路：

| 路 | 后果 |
| --- | --- |
| A. 继续往单体里加 | 半年后没人敢改；权限说不清谁用了什么；一个模块的异常能把整条消息循环搞挂 |
| **B. 拆成模块，SW 只做装配** | 加功能 = 写一个模块文件 + 一行注册；权限可反推、可审计 |

选了 B。这一层解决的是**可维护性与可审计性**，不是安全边界——
真正的安全边界是浏览器权限和那条一次性 nonce 链路。

---

## 2. 分层

```text
background/service-worker.js   47 行：建宿主 + 挂 onMessage
        ↓
lib/host.js                    Native 端口 + 消息来源门禁 + 生命周期接线
        ↓
lib/modules/*.js               各功能模块（不碰 chrome 全局，依赖注入）
        ↓
lib/modules.js                注册表：校验、分派、权限求和
lib/config.js                 配置中心：schema、命名空间、禁止密钥
lib/permissions.js            能力 → manifest 权限的映射与差异检查
```

**关键约束**：只有 `lib/host.js` 能 `connectNative`。content script 永远拿不到端口。

### 为什么这样分层

模块不碰 `chrome` 全局，而是由宿主注入依赖。好处很实际：

- 模块能在 node 里直接测（注入假实现即可）
- SW 本身依赖 `chrome.*` 全局，本来就测不动——把它压到 47 行，测不动的部分就只剩接线

---

## 3. 加一个新模块

三步。以"阅读模式"为例：

### 3.1 写模块

```js
// lib/modules/reader.js
export function createReaderModule(deps) {
  return {
    id: 'reader',
    title: '阅读模式',
    description: '去掉页面上的侧栏、广告与浮动元素，只留正文',
    defaultEnabled: false,          // 未声明则默认启用
    requires: ['contentScript'],    // 见 §4
    config: {
      width: { type: 'number', default: 680, min: 480, max: 1200, integer: true },
      theme: { type: 'enum', values: ['auto', 'light', 'dark'], default: 'auto' },
    },
    handlers: [
      {
        type: 'reader.toggle',
        handle: async (msg, ctx) => {
          // ctx.config.get('width')  读自己的配置
          // ctx.sender                原始 sender
          // ctx.kind                  'popup' | 'content' | 'unknown'
          return { ok: true, on: true };
        },
      },
    ],
  };
}
```

### 3.2 注册

```js
// lib/host.js
import { createReaderModule } from './modules/reader.js';
...
for (const m of opts.extraModules || []) registry.register(m);
```

或者在 `createHost` 里直接 `registry.register(createReaderModule(deps))`。

### 3.3 声明消息来源

在 `lib/host.js` 的 `KIND_REQUIREMENT` 里加一行：

```js
'reader.toggle': 'popup',   // 只有扩展页面能触发
```

**不填默认 `any`**。哪怕只是一条只读消息，也建议显式写清楚——
这张表是攻击面的清单，一眼能看完。

---

## 4. 能力清单

`lib/permissions.js` 里的 `CAPABILITIES` 是**穷举**的。模块 `requires` 里写清单外的名字，
注册时直接失败。

| 能力 | manifest 权限 | 说明 |
| --- | --- | --- |
| `nativeMessaging` | `nativeMessaging` | 与本地钥巢通信 |
| `activeTab` | `activeTab` | 用户点击后读当前页 |
| `scripting` | `scripting` | 注入脚本 |
| `webNavigation` | `webNavigation` | 感知导航（documentId 来源） |
| `tabs` | `tabs` | 标签页管理 |
| `hostHttps` | `host_permissions: https://*/*` | 跑内容脚本的站点范围 |
| `declarativeNetRequest` | `declarativeNetRequest` | 网络请求拦截 |
| `contentScript` | —（无需权限） | 修改页面内容 |
| `extensionPages` | —（无需权限） | 扩展自己的页面 |
| `notifications` | `notifications` | 通知 |
| `contextMenus` | `contextMenus` | 右键菜单 |
| `storage` | `storage` | 扩展本地存储（**禁止存密钥**） |
| `clipboardWrite` | `clipboardWrite` | 写剪贴板 |

### 权限反推与差异检查

```js
registry.requiredManifestPermissions();
// → { permissions: ['activeTab', 'nativeMessaging', ...], hostPermissions: [...] }

diffManifest(manifestJson, registry.list());
// → { missing, unused, missingHosts, ok }
```

`unused` 是非零就说明**权限膨胀**了——manifest 声明了但没有任何模块在用。
这个检查的价值在于：权限只增不减是这类扩展最常见的腐化方式。

**当前实测**（阶段 2.8，真实 Chrome）：

```
模块实际需要：activeTab、nativeMessaging、scripting、webNavigation
需要的站点范围：https://*/*
```

与 manifest 完全一致，`diffManifest().ok === true`。

---

## 5. 配置中心

`lib/config.js`。三条硬规则：

### 5.1 schema 就是边界

未声明的键**读不到也写不进**。没有 schema 的配置就是一堆 `undefined`，
模块读到 `undefined` 当成 `false`，于是"用户明明开了却像没开"。

### 5.2 带 secret 的 schema 注册不进来

```js
config.registerModule('x', { pw: { type: 'string', default: '', secret: true } });
// → ConfigError: SECRET_FORBIDDEN
```

不是"提醒你别这么写"，而是**根本注册不进去**。密码、token、主密码永远不会
因为某个模块图省事而被写进浏览器存储。

### 5.3 按模块分命名空间

后端键名形如 `keynest.cfg.<moduleId>`。模块 A 与 B 都写 `enabled` 不会互相踩。

### 存储后端

本阶段默认**内存后端**，不引入 `storage` 权限。

这是刻意的取舍：扩展当前连 `chrome.storage` 都没有（manifest 里没声明），
这正是它「不持久化任何敏感状态」的一部分。要持久化设置就得加权限，
那是一次需要单独审查的安全决策，不该被顺手塞进架构重构里。

需要持久化时，给 `ConfigCenter` 传一个实现 `{read, write, delete}` 的后端即可。

---

## 6. 消息来源门禁

`lib/host.js` 的 `classifySender` 分三类，判据是 `sender.id` + `sender.url`：

| 来源 | 判据 | 例 |
| --- | --- | --- |
| `popup` | URL 在特权页面白名单里 | `popup/popup.html`、`options/options.html` |
| `content` | `sender.tab` 存在且 URL 不是扩展页 | 网页里的 content script |
| `unknown` | 其余 | **包括 SW 自己发的消息** |

白名单是穷举的（`PRIVILEGED_PAGES`），没列进去的扩展页面一律 unknown。
这个"不方便"是刻意的：**新增特权入口必须是一次显式决定**。

### 为什么 SW 自己发的消息也是 unknown

这是重构时踩过的坑。在 SW 里 `chrome.runtime.sendMessage` 给自己，
`classifySender` 判成 unknown，`query` / `authorize-fill` 全被 `PRIVILEGED_ONLY` 拦下。

**这不是缺陷**：SW 自己发的消息本就不该被当成用户操作。所以验收脚本必须
从 popup.html（作为真实标签页打开）发特权消息，从 content script 的隔离世界发兑换。

---

## 7. 三条不变式

改任何模块前请先确认没破坏它们。这往下的每一条都在真实 Chrome 里验证过
（见 `test/acceptance/`）。

### 7.1 只有 host.js 能 connectNative

content script 永远拿不到端口。这条一破，网页就能直接和本地密码库对话。

### 7.2 密码只在模块的局部变量里短暂存在

绝不写 storage、绝不进日志、绝不进错误信息。
`modules.dispatch` 捕获异常时只回 `e.code`，**不回 `e.message`**——
后者可能带路径、条目名之类不该过桥的东西。

### 7.3 填充授权是状态机，不是"创建完就删掉"

一次性、5 秒 TTL（单调时钟）、绑定 tab/frame/origin/entry/documentId。
状态机在 `lib/auth-store.js`，状态流转见那里的注释。

---

## 8. 测试分层

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 单元 | `node --test tests/*.test.js` | 纯逻辑：配置、注册表、来源分类、授权状态机、兑换 |
| 集成（假 chrome） | 同上，`tests/host.test.js` | Native 端口生命周期、来源门禁、生命周期接线 |
| 真实 Chrome | `node test/acceptance/run.mjs` | 19 项端到端，见 `test/acceptance/README.md` |

单元/集成层用假 `chrome.*`，真实层用真 Chrome。**两层都不能省**：
阶段 2.6 的 8 个缺陷全部是手写 Win32/生命周期踩的坑，单元测试一个都没抓到。

---

## 9. 当前模块

| id | 名称 | 能力 | 可关闭 |
| --- | --- | --- | --- |
| `vault` | 密码填充 | nativeMessaging, activeTab, scripting, webNavigation, hostHttps | 否（核心） |
| `registry` | 模块管理 | extensionPages | 否（核心） |

关掉 `vault` 这个扩展就没有存在意义；关掉 `registry` 设置页会失去自我描述的能力。
所以两者在设置页显示为「核心模块」，`modules.set-enabled` 会返回 `MODULE_REQUIRED`。

---

## 10. 下一步

骨架已立，接下来按路线图加模块。每加一个模块：

1. 在 `CAPABILITIES` 里确认所需能力已存在（不存在先补，并想清楚它对应哪个 manifest 权限）
2. 写模块文件
3. 在 `KIND_REQUIREMENT` 声明消息来源
4. 跑 `diffManifest` 确认 manifest 同步更新
5. 补单元测试 + 一条真实 Chrome 用例
