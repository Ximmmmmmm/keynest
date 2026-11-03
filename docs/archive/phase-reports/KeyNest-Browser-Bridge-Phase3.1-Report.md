# KeyNest 阶段 3.1 报告 · 按站点暂停过滤（豁免名单）

> 基线 `516e3fd`（阶段 3.0）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：真实 Chrome 156 + 真实 `declarativeNetRequest`
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 豁免名单数据层 | 已落地（`lib/filters/allowlist.js`） |
| 模块接口 | `adblock.{allowlist,allow,disallow,check}` 四个消息 |
| popup 入口 | 「在此站暂停 / 恢复」按钮 + 状态显示 |
| 设置页入口 | 「设置」按钮（跳到 options） |
| 真实 Chrome 验收 | **32/32 全 PASS**（3.0 的 28 项 + 新增 4 项） |
| 扩展测试 | **304 通过**（原 272 + 新增 32） |
| **新权限** | **无** |

**本阶段没有引入任何新权限。** 用的是 2.9 已有的 `declarativeNetRequest`
和 3.0 已有的 `storage`——这正是路线图 A3 选它的原因：
已实现的能力缺一个用户入口。

---

## 1. 为什么单独抽一个 allowlist 文件

这份名单会被两个地方用：

| 入口 | 操作 |
| --- | --- |
| popup | 写（「在此站暂停」） |
| options | 读、删（「已豁免站点」列表） |

塞进 `adblock` 模块会让它同时承担"规则计算"与"用户偏好管理"两件事。
后者要处理脏数据、上限、去重、序列化——都不是规则计算该关心的。

而且它有一套自己的失败模式（见 §2），值得独立的测试文件。

---

## 2. 四条硬约束

### 2.1 上限 200 条

不设上限的话，用户逛得越久名单越长，最终每次安装规则都要遍历几万条，
`updateDynamicRules` 直接超时。**超时的表现是"过滤完全失效"**，
而用户只会觉得这个功能时灵时不灵。

超限时丢最旧的（列表末尾），新加的排最前。

### 2.2 只存域名，拒绝 URL

```js
normalizeEntry('https://example.test/')  // → null
normalizeEntry('example.test')           // → 'example.test'
```

**这是本轮抓到的一个真实隐患。** 最初 `adblock.allow` 用的是 `normalizeDomain`：

```js
normalizeDomain('https://example.test/')  // → 'https'
```

它把 scheme 当成了单个标签。于是名单里会出现一条叫 `https` 的豁免项——
永远匹配不上任何真实站点，而用户看到的是"点了暂停但还在拦"。

修复方式是在**入口**就拒绝带协议/路径/查询串的输入，而不是事后清洗：

```js
if (s.includes('/') || s.includes('://') || s.includes('?') || s.includes('#')) return null;
```

入口挡住比事后清洗清楚——因为"存 URL"本身还会带来
"路径变了还算不算豁免"的歧义，也会泄露浏览历史。

### 2.3 子域归属，不是字符串相等

```js
isAllowed(['example.test'], 'www.example.test')       // true
isAllowed(['example.test'], 'notexample.test')        // false  ← 关键
isAllowed(['example.test'], 'example.test.evil.test') // false  ← 关键
```

用补前导点的标签边界判断（和 `domain.js` 的 `belongsTo` 同一套规则）。

**这条不做的后果**：用户在 `example.com` 点暂停，站点跳到 `www.example.com`，
过滤又开始了。用户会认为"暂停按钮没用"。

### 2.4 存储里存 JSON 字符串

配置中心目前只支持标量（boolean/number/string/enum），所以名单序列化成
JSON 字符串：

```js
config: { allowlist: { type: 'string', default: '[]', maxLength: 8192 } }
```

**为什么不为名单加一个数组类型**：那是一次对配置中心的扩展，
会影响 schema 校验、脏数据丢弃、以及"值可比较"这些既有保证。
当前用字符串 + 出入两层清洗已经够用，等真有第二个模块需要数组时再统一做。

坏 JSON 当空名单——**一份坏名单不该让整个过滤功能用不了**。

---

## 3. 真实 Chrome 验收（32/32 PASS）

新增 4 项：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T13** | 暂停：写入名单并立即生成 `allowAllRequests` | **PASS** | `list:["example.test"]` → `allows:["example.test"]` |
| **T13b** | 子域被覆盖，相似域名不被覆盖 | **PASS** | `www.example.test → allowed:true`；`notexample.test → false` |
| **T13c** | 恢复：豁免规则被移除 | **PASS** | `remainingAllows:0` |
| **T13d** | 名单写进 `storage`（跨上下文） | **PASS** | `stored:"[\"persist.test\"]"` |

### 3.1 T13 验的是"立即生效"

用户点暂停后，期望是**当前页刷新就不再有拦截**，而不是"下次重启浏览器才生效"。
所以 `adblock.allow` 在写完配置后**立刻调 `applyRules`**，
而不是等下一次 `adblock.apply`。

T13 直接读 `getDynamicRules()` 确认规则真的在浏览器里，
不是只写进了配置。

### 3.2 原有的 28 项全部保持 PASS

包括密码填充 16 项、广告规则 6 项、存储 3 项。

---

## 4. popup 入口的设计取舍

### 4.1 广告过滤没启用时，整段不出现

```js
if (!enabled || !host) {
  hide(els.adblockSection);
  return;
}
```

对一个只用密码填充的用户来说，显示一段"广告过滤不可用"只会造成困惑——
他根本没启用这个功能。**默认关闭的模块不该在 UI 上占位置。**

### 4.2 没有 `tabs` 权限时优雅退化

`chrome.tabs.query({active:true})` 在没有 `tabs` 权限时**不返回 url**。
这不是错误，是浏览器的设计。

所以 popup 里：

```js
currentTabUrl = tab && tab.url;   // 可能是 undefined
```

广告过滤那一段因为 `hostOfUrl(undefined)` 返回 null 而自动隐藏。
**不为此申请 `tabs` 权限**——那会扩大权限面，而收益只是"在 popup 里显示域名"。

### 4.3 操作后提示"刷新页面后生效"

豁免规则改变不会自动重载已打开的页面。
说清楚比让用户猜好：

```
els.adblockNote.textContent = allowed
  ? '已恢复过滤，刷新页面后生效'
  : '已暂停过滤，刷新页面后生效';
```

---

## 5. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `lib/filters/allowlist.js` | 新增 | 规范化、清洗、增删、归属判断、JSON 解析 |
| `tests/allowlist.test.js` | 新增 | 23 项 |
| `lib/modules/adblock.js` | 改 | 四个新消息 + `allowlist` 配置项 + `writeAllowlist` |
| `lib/host.js` | 改 | 门禁表加 4 行 |
| `popup/{html,js,css}` | 改 | 按站点暂停的 UI 与逻辑；「设置」按钮 |
| `tests/adblock.test.js` | 改 | 加 9 项豁免接口测试 |

**manifest 未改，权限未变。**

---

## 6. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **304** | 原 272 + 新增 32 |
| 真实 Chrome | **32** | 全 PASS |
| Rust | 241 | 本轮未改 Rust |

新增测试的关键分布：

| 类别 | 条数 | 关注点 |
| --- | --- | --- |
| 规范化 | 3 | 拒绝 URL、协议、路径 |
| 清洗 | 4 | 去重、保序、截断、非数组 |
| 增删 | 6 | 提到最前、无意义改动返回同引用、超限丢最旧 |
| 匹配 | 5 | **标签边界**、大小写、尾点、空值 |
| 解析 | 3 | 坏 JSON 当空名单 |
| 模块接口 | 9 | 写配置、立即重装、拒绝脏输入、清洗存储数据 |

---

## 7. 数据保护与清理

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` | `42228` B / md5 `2bd94cde…` | **完全一致** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| Chrome / Edge 注册项 | `False` / `False` | **`False` / `False`** |
| 扩展存储 | — | 测试写入的豁免名单已清除 |
| 临时 profile | — | **已删除** |
| 遗留进程 | — | **0** |

**豁免名单里只有域名，没有 URL、没有页面内容、没有浏览历史。**
这是刻意的：存 URL 会让这份名单变成一份浏览记录。

---

## 8. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 豁免不区分档位 | 暂停后 `off`/`basic`/`strict` 都不拦。若将来要"只暂停 strict"，需要改规则结构 |
| 2 | 不自动重载页面 | 改完要用户手动刷新。自动 reload 会打断用户操作 |
| 3 | 名单上限 200 且无 UI 提示 | 超限时静默丢最旧的。应在设置页显示"已达上限" |
| 4 | 设置页还没有「已豁免站点」列表 | 数据层与接口已就绪（`adblock.allowlist`），UI 未做 |
| 5 | popup 无 `tabs` 权限时看不到域名 | 退化为隐藏整段，用户只能用设置页 |
| 6 | 未验证真实广告被暂停 | 本轮验的是规则层，不是"广告真的消失了" |

---

## 9. 停止点

**阶段 3.1 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- **无新权限**
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理

**下一步**（路线图 A2）：popup 承载多模块入口。
当前 popup 已经容纳"密码填充 + 广告过滤"两段，
下一个模块（阅读模式）加进来时要把这个模式整理成可复用的容器，
而不是继续往 `popup.js` 里堆 `if`。
