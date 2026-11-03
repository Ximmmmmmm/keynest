# KeyNest 阶段 3.2 报告 · Popup 面板系统

> 基线 `f40ab53`（阶段 3.1）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：真实 Chrome 156
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| popup 面板化 | 已完成（`panel-host.js` + `panels.js`） |
| `popup.js` | **292 行 → 108 行**，只做装配 |
| 加新功能的方式 | 注册一个面板，不改 `popup.html` / `popup.js` |
| 真实 Chrome 验收 | **34/34 全 PASS**（3.1 的 32 项 + 新增 2 项） |
| 扩展测试 | **323 通过**（原 304 + 新增 19） |
| **新权限** | **无** |

---

## 1. 为什么现在做

阶段 3.1 结束时，popup 里有两块 UI，都是"手写 HTML 段落 + 一段 `refreshXxx()` +
在 init 里调用"：

```text
popup.html: <section id="list-section">…</section>
            <section id="adblock-section">…</section>
popup.js:   async function init() { … await refresh(); await refreshAdblock(); }
            async function refresh() { /* 密码填充 */ }
            async function refreshAdblock() { /* 广告暂停 */ }
```

再加第三个模块（阅读模式、截图、笔记……）就会变成：

- `popup.html` 里越来越多的 `<section id="xxx-section">`
- `popup.js` 里越来越多的 `refreshXxx()`，且每个都要自己判断"模块启用了吗"
- 某个模块出错会拖垮整个 popup 的渲染

**在有两个的时候就抽，比在有三四个的时候抽便宜得多。**

---

## 2. 结构

```text
popup/
├── popup.html       只有 <main id="panels"></main> + 错误条 + 页脚
├── popup.js         108 行：建 PanelHost、注册两个面板、渲染
├── panel-host.js    面板容器：注册、排序、可用性过滤、错误隔离
└── panels.js        两个内置面板的具体实现
```

### 2.1 加一个新面板

```js
// 在 popup.js 里加一行
host.register(createReaderPanel({ getTabId: () => currentTab?.id }));
```

`popup.html` 不用改，`popup.js` 的 init 也不用改。

---

## 3. 三条保证

### 3.1 单个面板抛错不影响其他

```js
try {
  await panel.render(this.forPanel(section));
} catch (e) {
  section.replaceChildren();
  note.textContent = '这个面板暂时不可用';   // 不显示 e.message
}
```

不显示 `e.message` 是有意的：它可能带路径、内部状态。用户需要的只是
"这块坏了，别的还能用"。

测试断言了这一点（`panel-host.test.js` 的「不该把 e.message 暴露给用户」）。

### 3.2 未启用/不可用的面板**连容器都不创建**

```js
if (panel.moduleId && !this.enabledModules.has(panel.moduleId)) continue;
if (typeof panel.available === 'function' && !(await panel.available())) continue;
const section = document.createElement('section');   // ← 到这里才建
```

留下空容器会有两个副作用：布局里出现不可见的间隙；`#panels section` 的计数
失去意义（验收脚本用它判断渲染结果）。

### 3.3 模块状态只问一次

`modules.list` 在 `renderAll()` 开头问一次，结果缓存到 `enabledModules`。
不是每个面板各问一次——那会让 popup 打开时发 N 个消息。

---

## 4. 真实环境抓到的一个设计缺口

### 缺口（中）：`moduleId` 过滤不足以表达"我现在没东西可显示"

| 项 | 内容 |
| --- | --- |
| **现象** | T14b 失败：popup 作为标签页打开时，`adblock` 面板的容器仍然存在（里面空） |
| **根因** | 面板的 `render()` 自己 `if (!hostName) return;` 提前返回，但容器已经被 PanelHost 创建了 |
| **影响** | 布局出现空框；验收脚本读到 `ids:["fill","adblock"]` 与预期不符 |
| **修复** | 面板可声明 `available: () => boolean|Promise<boolean>`，为假时**连容器都不建** |

这个缺口的性质是"**职责放错了层**"：
"能不能显示"是**装配层**该判断的事（它决定要不要建容器），
而原来把它写在了 `render()` 里（那时容器已经建好了）。

### 4.1 `available` 抛错按不可用处理

```js
try { ok = await panel.available(); } catch { ok = false; }
```

一个判断不出来的面板不该冒出一个空框。

### 4.2 adblock 面板的真实判定

```js
available: () => hostOfUrl(deps.getTabUrl()) !== null
```

两种情况都拿不到域名：

| 情况 | `tab.url` 的值 |
| --- | --- |
| 没有 `tabs` 权限 | `undefined` |
| popup 作为标签页打开 | `chrome-extension://…`（是它自己） |

两种都该整块跳过——**不是显示一个点了会失败的按钮**。

---

## 5. 真实 Chrome 验收（34/34 PASS）

新增 2 项：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T14** | popup 通过面板系统渲染（fill 面板存在，无渲染错误） | **PASS** | `ids:["fill"]`，`hasError:false` |
| **T14b** | 拿不到站点域名时 adblock 面板整块跳过 | **PASS** | `ids:["fill"]`（不含 adblock） |

### 5.1 T14 验的是"渲染出来了"，不是"代码里有"

`#panels section` 的 `dataset.panel` 列表是从真实 DOM 读的。
如果 PanelHost 抛错、面板全挂，这里会读到空数组，而不是"看起来 PASS"。

### 5.2 原有的 32 项全部保持 PASS

包括密码填充 16 项（其中 T7/T7e 走真实填充路径）、广告 10 项、存储 3 项。

---

## 6. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `popup/panel-host.js` | 新增 | 面板容器：注册、排序、过滤、错误隔离、`available` |
| `popup/panels.js` | 新增 | 密码填充面板 + 广告暂停面板 |
| `tests/panel-host.test.js` | 新增 | 19 项（含最小 DOM 替身） |
| `popup/popup.js` | 重写 | 292 → 108 行，只做装配 |
| `popup/popup.html` | 重写 | 只剩 `<main id="panels">` |
| `popup/popup.css` | 改 | `.block-*` → `.panel-*`，加 `.panel-error` |
| `test/acceptance/run.mjs` | 改 | 加 T14 / T14b |

**manifest 未改，权限未变，SW 未改。**

---

## 7. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **323** | 原 304 + 新增 19 |
| 真实 Chrome | **34** | 全 PASS |
| Rust | 241 | 本轮未改 Rust |

### 7.1 为什么用最小 DOM 替身而不是 jsdom

`PanelHost` 只用到 `document.createElement`、`append`、`replaceChildren`、
`dataset`、`classList` 这几样。为了这些引入 jsdom（几 MB、还有自己的 DOM
语义差异）不划算。

替身只有 40 行，且**逼真到能抓住真实的错误**——
比如 `withFakeDocument` 最初写成同步的，导致异步 `renderAll` 在 document
恢复之后才跑，10 个测试一起红。那个 bug 在 jsdom 下同样会红，但在"什么都不用、
直接跑"的情况下会被掩盖。

---

## 8. 数据保护与清理

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` | `42228` B / md5 `2bd94cde…` | **完全一致** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| Chrome / Edge 注册项 | `False` / `False` | **`False` / `False`** |
| 临时 profile | — | **已删除** |
| 遗留进程 | — | **0** |

---

## 9. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 面板刷新是"整块重渲" | 广告面板操作后调 `panel.render(host)` 重建自己的内容。简单可靠，但会丢掉焦点。当前面板里没有输入框，所以无影响；将来有输入框的面板要改成局部更新 |
| 2 | 面板顺序靠 `order` 手写 | 没有"模块声明自己想排在哪个模块之后"的机制。模块多了之后可能要引入依赖式排序 |
| 3 | popup 打开时才问模块状态 | SW 侧模块开关变化不会实时推送到已打开的 popup。用户要刷新 popup（点「刷新」或重开） |
| 4 | 面板样式共用一套 class | `.panel` / `.panel-head` / `.panel-title` 是所有面板共用的。某个面板需要特殊布局时要么加自己的 class，要么改公共样式——后者会影响所有面板 |
| 5 | 未做面板折叠 | 面板多了之后 popup 会很长。折叠/手风琴留到有实际需要时 |

---

## 10. 停止点

**阶段 3.2 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- **无新权限**
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理

**下一步**：路线图 A 类已全部完成（A1 持久化、A2 面板系统、A3 按站点暂停）。
可以进入 B 类功能模块。第一个建议是**阅读模式**——
它是"修改页面内容"类模块的第一个，会第一次用到 `contentScript` 能力写路径，
能把骨架里"内容脚本如何按模块启用/停用"这条链路压出来。
