# KeyNest 阶段 2.9 报告 · 广告与跟踪器过滤（首个功能模块）

> 基线 `e462521`（阶段 2.8）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：**真实 Chrome 156.0.8078.80** + 真实 `declarativeNetRequest`
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 首个功能模块 | 已落地（规则引擎 + 模块 + 设置页档位） |
| 真实 Chrome 验收 | **25/25 全 PASS**（2.8 的 19 项 + 新增 6 项） |
| 扩展测试 | **251 通过**（原 182 + 新增 69） |
| 真实环境抓到缺陷 | **2 个**（都不是安全问题，但都会让功能不可用） |
| 骨架是否够用 | **够用**——加这个模块只碰了「加一个文件 + 注册一行 + 门禁表一行」 |

---

## 1. 为什么把广告过滤作为第一个功能模块

阶段 2.8 立了骨架，但骨架没被真实功能压过。选广告过滤当第一个，是因为它一次压到
三根最容易被设计错的梁：

| 压力点 | 如果骨架设计错了会怎样 |
| --- | --- |
| 新 manifest 权限（`declarativeNetRequest`） | 权限清单与实际脱节，"模块要权限"变成手工维护的谎言 |
| 动态规则集（会失败、会冲突、要原子替换） | 模块没有"安装失败"的表达能力，只能静默 |
| 按站点豁免（优先级博弈） | 豁免与拦截互相打架，用户看到"点了暂停但还是被拦" |
| 默认关闭（改变网页行为的模块） | 一装上就改用户网页，且无法解释 |

跑完的结果：骨架够用，只改了三处——`CAPABILITIES` 里本来就有这个能力、
`KIND_REQUIREMENT` 加三行、`host.js` 加一次注册。

---

## 2. 设计取向：宁可少拦，不可错拦

广告过滤最怕的不是漏几个广告，是**拦坏正经页面**。
一个把支付回调拦掉的过滤器，用户会立刻删掉它，而且再也不会装第二次。

所以三档默认保守：

| 档位 | 拦什么 | 规则数（实测） |
| --- | --- | --- |
| `off` | 什么都不拦，**规则集清空** | 0 |
| `basic`（默认） | 只拦「整域只为广告/跟踪而存在」的 46 个域名 | 46 block |
| `strict` | 追加 8 个混合用途域 + 20 个跟踪参数剔除 | 54 block + 20 redirect |

### 2.1 主域绝不进清单

这是一条硬约束，也有测试守着（`filters.test.js` 的「主域绝不进清单」）：

```
google.com 必须不在清单里
```

`doubleclick.net` 整个域都是广告，可以拦；
但 `google.com` 的某个子域确实做统计，拦掉整域会把搜索、地图、登录一起干掉。

### 2.2 不做元素隐藏

元素隐藏（cosmetic filtering）要往每个页面注入 CSS。出错的表现是"网站布局塌了"，
比漏广告严重得多。留到单独阶段，且必须能一键关。

### 2.3 用 dNR 而非 webRequest

MV3 不给普通扩展 `webRequestBlocking`。而且 dNR 由浏览器内核匹配，
每条请求不过 JS——扩展看不到请求内容，性能与隐私都更好。

---

## 3. 真实环境抓到的两个缺陷

### 缺陷 1（中）：`thirdParty` 不是 dNR 的字段名

| 项 | 内容 |
| --- | --- |
| **现象** | strict 档安装失败，返回 `DNR_FAILED`，规则数为 0 |
| **根因** | 条件写成 `condition: { thirdParty: true }`，Chrome 要的是 `domainType: 'thirdParty'` |
| **Chrome 的原话** | `Error at property 'condition': Unexpected property: 'thirdParty'.` |
| **为什么单元测试没抓到** | 假 dNR 对任何字段都照单全收 |
| **修复** | 改用 `domainType: 'thirdParty'` |
| **防止复发** | 假 dNR 现在按 Chrome 的字段白名单校验（`CONDITION_KEYS`），写错字段名在单元层就抛 `Unexpected property` |

这一类缺陷和阶段 2.6 那 8 个 Win32 缺陷是同一性质：**只有真实环境会告诉你
"这个字段名/常量/标志位不是你想象的那样"**。假实现越宽松，越容易掩盖真实约束。

### 缺陷 2（中）：`adblock.apply` 不写回配置

| 项 | 内容 |
| --- | --- |
| **现象** | 切到 strict → 刷新设置页又显示 basic |
| **根因** | handler 读了 `ctx.config.get('mode')` 但从不 `set` |
| **影响** | 用户的选择不生效，且界面上没有任何报错 |
| **修复** | 安装成功后 `await ctx.config.set('mode', msg.mode)` |
| **细节** | **只在安装成功时写**。安装失败还写配置，会让"配置说的"与"规则实际的"不一致 |
| **测试** | `adblock.test.js` 两条：成功写入、失败不写 |

---

## 4. 真实 Chrome 验收（25/25 PASS）

在 2.8 的 19 项之上新增 6 项，全部围绕「规则真的进了浏览器」：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T11pre** | 模块默认关闭时，其消息被 `MODULE_DISABLED` 拦下 | **PASS** | `{ok:false, error:"MODULE_DISABLED"}` |
| **T11pre2** | 通过设置页接口启用模块 | **PASS** | `{ok:true, id:"adblock", enabled:true}` |
| **T11** | basic 档真实安装动态规则 | **PASS** | `rules:46`，`getDynamicRules().count:46`，`maxPriority:2` |
| **T11b** | strict 档规则更多且含 redirect | **PASS** | `rules:74`，类型 `["block","redirect"]` |
| **T11c** | off 档清空全部动态规则 | **PASS** | `remaining:0` |
| **T11d** | 豁免域名生成 `allowAllRequests` | **PASS** | `[{pri:100, domains:["localhost"]}]` |

**T11pre 是刻意设计的**：它证明「模块开关不是装饰」——
关着的模块连自己的消息都收不到，这是骨架层面的保证，不是业务代码里的 `if`。

### 4.1 原有的 19 项全部保持 PASS

包括最敏感的 T7（100 并发只成功 1 次）、T7e（username 填充）、T5e（Tab 关闭失效）。
加新模块没有碰到密码填充链路的任何一行。

---

## 5. 规则引擎的关键实现

### 5.1 域名匹配：标签边界

```js
belongsTo('a.evil.com', 'evil.com')        // true
belongsTo('notevil.com', 'evil.com')       // false  ← 关键
belongsTo('evil.com.evil.test', 'evil.com')// false  ← 关键
```

实现方式是**补前导点再比后缀**。直接 `host.endsWith(domain)` 会让
`notevil.com` 命中 `evil.com`——这类错误看起来天经地义，但只测正例永远发现不了。

`filters.test.js` 里失败路径比成功路径多，原因就是这个。

### 5.2 用 `requestDomains` 而不是 `urlFilter`

```js
// 对
condition: { requestDomains: ['doubleclick.net'] }

// 错（子串匹配会把无关请求一起杀掉）
condition: { urlFilter: 'doubleclick.net' }
```

`urlFilter` 是子串匹配，`https://evil.test/?x=ad.doubleclick.net` 会被误杀。

### 5.3 规则 id 必须全局唯一且稳定

dNR 里 id 重复会导致**整批安装失败**——表现是"过滤完全没生效"，
而用户看到的是"开了但没拦住"，极难排查。

两条测试守着：

- id 全局唯一（`filters.test.js`）
- basic 的规则 id 在 strict 里**保持不变**（切档位时只有新增，不重排）

### 5.4 豁免规则的优先级

`allowAllRequests` 的 priority 是 **100**，所有 block 规则最高是 2。
测试直接断言这个大小关系（`adblock.test.js` 的「豁免规则用 allowAllRequests 且优先级最高」）——
优先级写反了不会报错，只会让"暂停"看起来失效。

### 5.5 安装必须原子

```js
await dnr.updateDynamicRules({ removeRuleIds: [...], addRules: [...] });
```

`removeRuleIds` 与 `addRules` 必须在**同一次调用**里。分两次调用会有一段
"规则为空"的窗口，用户能感知到广告闪一下。

---

## 6. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `lib/filters/domain.js` | 新增 | 域名规范化与归属判断 |
| `lib/filters/rules.js` | 新增 | 规则构造（清单 → dNR 规则） |
| `lib/modules/adblock.js` | 新增 | 模块：安装、豁免、诊断、错误分类 |
| `tests/filters.test.js` | 新增 | 32 项（失败路径为主） |
| `tests/adblock.test.js` | 新增 | 25 项（安装/豁免/错误） |
| `tests/manifest-consistency.test.js` | 新增 | 12 项（权限漂移防线） |
| `lib/host.js` | 改 | 注册 adblock；门禁表加 3 行 |
| `lib/modules.js` | 改 | `list()` 增加 `configSchema`，设置页才能渲染选中项 |
| `lib/permissions.js` | 改 | `diffManifest` 同时看 `host_permissions` 与 `optional_host_permissions` |
| `options/{html,js,css}` | 改 | 档位选择器（按 schema 渲染，不硬编码"广告过滤有档位"） |
| `manifest.json` | 改 | 加 `declarativeNetRequest`；版本 0.6.0 → 0.7.0 |
| `test/acceptance/run.mjs` | 改 | 加 T11pre / T11pre2 / T11 / T11b / T11c / T11d |

### 6.1 权限清单又一次证明了自己

加 `declarativeNetRequest` 之前先跑了一次 diff：

```
missing: ["declarativeNetRequest"], ok: false
```

改完 manifest 再跑：`ok: true`。
`tests/manifest-consistency.test.js` 现在把这条做成常驻测试——
以后加模块忘加权限，或者加了权限没模块用，都会在 CI 层红掉。

### 6.2 一处顺带修的偏差

`diffManifest` 原来只看 `host_permissions`，而本项目把全站权限放在
`optional_host_permissions` 里（安装时不弹窗）。结果是它一直误报"缺少 host 权限"。
现在两个字段都看。这类报警如果不修，很快就没人看了。

---

## 7. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **251** | 原 182 + 新增 69 |
| 真实 Chrome | **25** | 全 PASS |
| Rust | **241** | 本轮未改 Rust |

新增测试的分布特征：

| 文件 | 数量 | 失败路径占比 |
| --- | --- | --- |
| `filters.test.js` | 32 | 约 70% |
| `adblock.test.js` | 25 | 约 55% |
| `manifest-consistency.test.js` | 12 | 约 50% |

**失败路径多不是风格偏好，是因为这个模块的主要风险在"错拦"而不是"漏拦"。**

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

**动态规则不写入任何用户数据**：它们只存在于浏览器的扩展存储中，
测试结束时随临时 profile 一起删除。

---

## 9. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 不做元素隐藏 | 要注入 CSS，出错会让网站布局塌掉。留到单独阶段 |
| 2 | 清单只有 54 个域名 | 不是完整广告库。**刻意如此**：错拦一个正经站点的代价，远大于漏拦几十个广告 |
| 3 | 豁免名单不持久化 | 配置中心仍是内存后端（见 2.8 报告 §3.2），SW 重启后豁免丢失 |
| 4 | 未做"按站点快速暂停"UI | 模块层已支持 `allowDomains`，popup 里的入口还没做 |
| 5 | strict 档的 `strict` 域含混合用途域名 | `facebook.com/tr` 这类在 strict 下拦，basic 不拦——用户显式选择更强隐私才生效 |
| 6 | 未验证真实广告是否被拦 | 本轮验的是"规则进了浏览器"，不是"广告真的消失了"。后者需要真实广告页面，属于后续真实环境验收 |
| 7 | 规则数上限 5000 | Chrome 硬上限。当前 74 条，远未接近，但清单扩充时要有测试守着 |

---

## 10. 停止点

**阶段 2.9 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- 真实库与真实 bridge.key 未触碰
- 未访问任何真实广告页面
- 临时环境已完全清理，无遗留进程

**下一步**：按骨架继续加模块。两个已验证可复用的东西——
`manifest-consistency.test.js` 的权限漂移防线，与「失败路径为主」的测试取向——
会直接带到后续每个模块。
