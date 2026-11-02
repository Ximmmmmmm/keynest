# KeyNest 阶段 3.4 报告 · 夜间模式 + 注入辅助层

> 基线 `246153e`（路线图）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：真实 Chrome 156
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 夜间模式 | 已落地 |
| **新增抽象：注入辅助层** `lib/inject.js` | 把"查权限 → 按需申请 → 注入"收敛成一处 |
| 阅读模式 | 也改为走注入辅助层（消除重复样板） |
| 真实 Chrome 验收 | **43/43 全 PASS**（3.3 的 40 项 + 新增 3 项） |
| 扩展测试 | **403 通过**（原 369 + 新增 34） |
| **新权限** | **无** |

---

## 1. 这一阶段顺带做了一次真实的抽象

阶段 3.3 的阅读模式里，有一段"查站点权限 → 按需申请 → 才注入"的样板代码。
夜间模式要用同一套逻辑，于是面临选择：

| 做法 | 后果 |
| --- | --- |
| 复制一遍 | 两个模块各有一份；第三个模块再复制一次。某一份忘了"先查再请求"就会每次弹框 |
| **抽成 `lib/inject.js`** | 一处实现，测试也只需测一处 |

选了后者。这不是"为了抽象而抽象"——它有两个具体收益：

1. **重复的样板会被写漏**。`ensureHostPermission` 里"先 `contains` 再 `request`"
   这个顺序，写错了不会有任何报错，只会让用户每次点都弹一次确认框。
2. **错误映射要统一**。`executeScript` 抛的 `"Cannot access contents of the page"`
   必须映射成 `HOST_PERMISSION_DENIED`，而不是笼统的 `INJECT_FAILED`——
   否则上层没法告诉用户"该重新授权"。

抽出来之后，阅读模式也改用了它（净减约 40 行）。

---

## 2. 注入辅助层的四个函数

```js
originPatternOf(webNavigation, tabId)   // → 'https://example.com/*' 或 null
ensureHostPermission(permissions, origin) // 先查再请求
runInFrame(scripting, tabId, func, args)  // 只注入主 frame，错误映射
injectInto(deps, tabId, func, args, opts) // 上面三步的组合
```

### 2.1 只接受 http/https

`originPatternOf` 对 `chrome://`、`file://`、`about:blank` 返回 null。
**不是"以后再过滤"**——如果让它们走到 `permissions.request`，
会弹一个必然被拒的确认框，用户会以为扩展坏了。

### 2.2 卸载不需要权限

```js
injectInto(deps, tabId, darkToggle, [{ action: 'uninstall' }], { needPermission: false })
```

样式和 class 本来就是我们自己加的，移除它不需要站点权限。
要求权限会让"我授权过的站点后来撤销了授权，现在连关都关不掉"变成现实。

这条有测试守着（`inject-dark.test.js` 的「卸载不请求权限」与
「needPermission:false 时跳过权限检查」）。

### 2.3 错误映射要能区分

| Chrome 原话 | 映射 |
| --- | --- |
| `Cannot access contents of the page…` | `HOST_PERMISSION_DENIED` |
| 其它 | `INJECT_FAILED` |

不把 `e.message` 带出去——它含 Chrome 的长句与内部路径。
但要把这两种分开：上层据此决定提示"请重新授权"还是"操作失败"。

---

## 3. 夜间模式的设计取舍

### 3.1 为什么不用"改每个元素的颜色"

常见做法：

```css
* { background: #111 !important; color: #eee !important }
```

必然把某些站点弄花：图标变黑块、渐变失效、`background-image` 上的文字全看不见。

### 3.2 用一层滤镜

```css
html.keynest-dark body { filter: invert(1) hue-rotate(180deg) brightness(92%) contrast(100%); }
html.keynest-dark img, html.keynest-dark video, … { filter: invert(1) hue-rotate(180deg) !important; }
```

| 项 | 效果 |
| --- | --- |
| `invert(1)` | 白底黑字 → 黑底白字 |
| `hue-rotate(180deg)` | 抵消反色造成的偏色（否则蓝色链接会变橙） |
| 图片/视频二次反色 | 否则照片会变成负片 |

**代价**：滤镜是合成层，大页面滚动时可能影响性能。所以给了三个可调参数
（`brightness` / `contrast` / `sepia`），而不是写死一个值。

### 3.3 参数必须夹紧

```js
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
```

配置值可能从存储里读出脏数据。滤镜写坏的表现是**整页变花**，
而且不会有任何报错。有两条测试守着：
「参数被夹紧」与「滤镜里不出现 NaN / undefined」。

### 3.4 重复启用只保留一份样式

```js
const existing = document.getElementById(STYLE_ID);
if (existing) existing.remove();
```

不这么做的话，反复点"开启"会让 `<style>` 叠加，旧参数的滤镜仍然生效——
表现是"调了亮度但没变化"。

---

## 4. 真实 Chrome 验收（43/43 PASS）

新增 3 项：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T16** | 注入后根元素加 class 且样式存在 | **PASS** | `{brightness:92, contrast:100, sepia:0}` |
| **T16b** | 滤镜参数写进样式且不含 NaN/undefined | **PASS** | `filter: invert(1) hue-rotate(180deg) brightne…` |
| **T16c** | 关闭后 class 与样式全部清除 | **PASS** | `removed:true` |

### 4.1 原有的 40 项全部保持 PASS

包括阅读模式的 6 项。阅读模式改用注入辅助层后行为未变——
这正是抽对抽象的判据：**重构后既有测试一条都不用改**。

（实际上改了两条：把"抛错"改成"返回结构化错误码"，因为错误映射变得更明确了。
那是行为改进，不是破坏。）

---

## 5. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `lib/inject.js` | 新增 | 注入辅助层（132 行） |
| `lib/modules/dark.js` | 新增 | 夜间模式模块 + 自包含注入函数（171 行） |
| `tests/inject-dark.test.js` | 新增 | 33 项 |
| `lib/modules/reader.js` | 改 | 改用 `injectInto`，删掉本地的权限样板 |
| `lib/host.js` | 改 | 注册 dark；门禁表加 2 行 |
| `popup/panels.js` | 改 | 加 `createDarkPanel` |
| `popup/popup.js` | 改 | 注册夜间面板 |
| `test/acceptance/run.mjs` | 改 | 加 T16 / T16b / T16c |
| `manifest.json` / `package.json` | 改 | 版本 0.9.0 → 0.10.0 |

**manifest 的 permissions 数组未改。**

---

## 6. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **403** | 原 369 + 新增 34 |
| 真实 Chrome | **43** | 全 PASS |
| Rust | 241 | 本轮未改 Rust |

新增测试的分布：

| 类别 | 条数 | 关注点 |
| --- | --- | --- |
| origin 提取 | 3 | 非 http(s) 不弹框、脏 tabId |
| 权限 | 5 | **先查再请求**、拒绝、抛错 |
| 注入 | 5 | 只注主 frame、空结果、错误映射、不泄露 message |
| `injectInto` 组合 | 4 | NO_ORIGIN 不注入、被拒不注入、卸载跳过权限 |
| 夜间注入函数 | 7 | class/样式、图片二次反色、参数夹紧、不叠加 |
| 夜间模块 | 6 | 默认关闭、参数透传、卸载不请求权限 |

---

## 7. 数据保护与清理

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` | `42228` B / md5 `2bd94cde…` | **完全一致** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| Chrome / Edge 注册项 | `False` / `False` | **`False` / `False`** |
| 临时 profile | — | **已删除** |
| 遗留进程 | — | **0** |

夜间模式只操作当前 tab 的 `documentElement`，不读页面内容、不请求网络、不写存储。

---

## 8. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 滤镜有性能代价 | 大页面滚动时可能掉帧。给的是可调参数而非"关掉"，因为关掉就没功能了 |
| 2 | iframe 内部不受影响 | 跨域 iframe 无法注入。只做了 `opacity: 0.92` 让它不那么刺眼 |
| 3 | `background-image` 上的文字可能对比度变差 | 反色会改变图片基调。这是滤镜方案的固有代价，改元素颜色的方案更糟 |
| 4 | 只支持主 frame | `frameIds: [0]` |
| 5 | 设置页还没有三个参数的 UI | 配置项已就绪；当前用默认值 |
| 6 | 不记忆"哪些站点已开启" | 刷新页面后夜间模式消失。要做需要按站点持久化状态（可复用豁免名单的模式） |
| 7 | 未与阅读模式互斥 | 两个都开时，滤镜作用在 `body` 上，阅读模式容器在 `body` 内，会一起被反色——这其实是期望行为，但没有测试明确覆盖 |

### 关于第 6 条

这是当前最影响实用性的限制。用户开了夜间模式，翻页就没了。
要修需要按站点存状态，而 `allowlist.js` 已经提供了"域名规范化 + 上限 + 去重"那一套，
可以直接复用。这也说明阶段 3.1 把豁免名单抽成独立文件是对的。

---

## 9. 停止点

**阶段 3.4 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- **无新权限**
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理

**下一步建议**：

1. **按站点记忆开关**（夜间模式、阅读模式都需要）——复用 `allowlist.js` 那套
2. **二维码** —— 零权限模块，可作为"不需要任何浏览器能力"的样板
3. **网页截图** —— 第一次用到"读画面"，会压到 `captureVisibleTab` 这条新链路

至此骨架已被四条不同的能力路径压过（dNR 规则、storage、scripting 注入、按站点权限），
再加模块基本是业务逻辑。
