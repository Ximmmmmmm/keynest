# KeyNest 阶段 3.0 报告 · 配置持久化（打开 `storage` 权限）

> 基线 `00d5458`（路线图）· 分支 `feat/browser-bridge` · main `09b870d` 未动 · v0.4.3 `2bd390e` 未动
> 日期：2026-11-02
> 测试环境：真实 Chrome 156 + 真实 `chrome.storage.local`
> **未注册 Edge、未触碰真实库与真实 bridge.key、未推送/合并/发布。**

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| 配置持久化 | 已落地（`chrome.storage.local`） |
| 权限变更 | **新增 `storage`**，这是本阶段唯一一次权限扩张 |
| 真实 Chrome 验收 | **28/28 全 PASS**（2.9 的 25 项 + 新增 3 项） |
| 扩展测试 | **272 通过**（原 251 + 新增 21） |
| 真实环境抓到缺陷 | **1 个**（命名空间前缀重复，导致"存了但读不回"） |

---

## 1. 这一步为什么需要单独一个阶段

阶段 2.8 的架构文档里写着：

> 配置中心默认**内存后端**，不引入 `storage` 权限。
> 这是刻意的取舍：扩展当前连 `chrome.storage` 都没有，这正是它
> 「不持久化任何敏感状态」的一部分。

现在要持久化用户设置（广告档位、豁免名单、模块开关），就必须打开这个口子。
**打开一个权限口子是一次独立的决策，不该混在功能开发里顺手做。**

所以这一阶段只做持久化本身，不碰任何业务逻辑。

---

## 2. 权限边界的写法

### 2.1 三层保证

| 层 | 保证 | 实现 |
| --- | --- | --- |
| schema | 带 `secret:true` 的配置**注册不进来** | `config.js` 的 `SECRET_FORBIDDEN` |
| 载入 | 存储里的脏数据/未知键在 `load()` 时被丢弃 | `ConfigCenter.load()` 返回 `dropped` |
| 审计 | 实际存了什么可被列举与扫描 | `inspectStorage()` / `scanForSensitiveKeys()` |

第三层是**防御性**的，不是安全边界。它的价值在于：万一有模块绕过配置中心
直接写存储，测试能发现——而不是靠人读代码。

### 2.2 只用 `storage.local`，不用 `storage.sync`

`sync` 会把数据传到 Google 账户，那不是"本地密码管理器"该做的事。

**但这里有个坑**（T12c 踩到）：声明 `storage` 权限后，`chrome.storage.sync`
这个**对象永远存在**。所以"有没有 sync API"不是判据——真正的判据是
**sync 区里有没有我们的键**。

```js
// 错：永远为 true
!!(chrome.storage && chrome.storage.sync)

// 对：检查实际数据
chrome.storage.sync.get(null).then(g =>
  Object.keys(g).filter(k => k.startsWith('keynest.')))   // → [] 才通过
```

真实 Chrome 实测：`syncKeys: []`，`localHasData` 有键。符合预期。

### 2.3 存储不可用时退回内存

`pickStore()` 的探测不是"看 API 存在"，而是**真写一次再删掉**：

```js
await area.set({ [probeKey]: 1 });
const got = await area.get(probeKey);
await area.remove(probeKey);
if (!got || got[probeKey] !== 1) return { persistent: false, reason: 'PROBE_MISMATCH' };
```

只看存在性会误判——某些环境里 API 在但写入被静默丢弃（配额、策略拦截）。
探测失败就退回内存后端，扩展仍能用，只是设置不持久。

三种失败原因都分开报（`NO_STORAGE_PERMISSION` / `PROBE_MISMATCH` / `PROBE_FAILED`），
而不是笼统一个 `不持久`——排查时这个区分很关键。

---

## 3. 真实环境抓到的缺陷

### 缺陷（中）：命名空间前缀重复，导致"存了但读不回"

| 项 | 内容 |
| --- | --- |
| **现象** | 写入成功，`chrome.storage.local` 里能看到键，但配置读回来是默认值 |
| **根因** | 配置中心生成 `keynest.cfg.<module>`，存储后端又加一次 `keynest.` 前缀 → 实际键是 `keynest.keynest.cfg.<module>` |
| **影响** | 用户在设置页改了档位，SW 重启后回到默认。**两边都不报错** |
| **为什么单元测试没抓到** | 阶段 2.8 的 `MemoryStore` 测试直接用 `keynest.cfg.m` 作为键，绕过了真实后端 |
| **修复** | 配置中心只给 `cfg.<module>`，前缀统一由 `storage.js` 负责 |
| **防止复发** | `storage.test.js` 有一条"配置经持久后端后能被新实例读回（模拟 SW 重启）"，直接走 `ChromeStorageStore` |

这个缺陷的性质值得记下来：**它是"两个各自正确的东西拼在一起错了"**。
配置中心的命名空间没错，存储后端加前缀也没错，错在两边都以为自己该加。
只有把两层真的接起来跑一遍才能发现——这正是 `pickStore` 探测要"真写一次"的同一个道理。

---

## 4. 真实 Chrome 验收（28/28 PASS）

新增 3 项：

| # | 测试 | 结果 | 证据 |
| --- | --- | --- | --- |
| **T12** | 配置跨上下文持久（options 写 → popup 读回） | **PASS** | 写 `{enabled:true,mode:'strict'}`，popup 读回一致 |
| **T12b** | 扩展存储里没有任何敏感键 | **PASS** | `keys:["keynest.cfg.adblock"]`，`hits:[]` |
| **T12c** | 只写 `storage.local`，`sync` 区为空 | **PASS** | `syncKeys:[]`，`syncQuota:102400` |

### 4.1 T12 为什么是"跨上下文"而不是"写后即读"

同一个上下文里写后即读，只能证明"内存里存住了"。
真实场景是：用户在 **options 页**改设置 → 关掉 → **SW 重启** → 打开 **popup**
→ 设置还在。

所以 T12 在 options 页写、在 popup 页读。这是两个不同的扩展页面、不同的 JS 环境，
只有真正落到 `storage.local` 才能读到。

### 4.2 原有的 25 项全部保持 PASS

包括密码填充的 13 项、广告过滤的 6 项。改 `createHost` 为 async
（因为要探测存储）没有影响任何既有行为。

---

## 5. `createHost` 改异步的连锁处理

存储探测是异步的，所以 `createHost` 必须是 async。这带来两个必须处理对的点：

### 5.1 消息监听器仍要**同步**注册

MV3 的 SW 可能因为某条消息才被唤醒。监听器晚一步注册就会漏掉唤醒事件。
所以 SW 里：

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  host().then(h => h.onMessage(msg, sender, sendResponse))
        .catch(() => sendResponse({ ok: false, error: 'HOST_INIT_FAILED' }));
  return true;   // ← 必须，否则消息通道立刻关闭
});
```

`return true` 在异步分支里尤其容易漏。漏了的表现是"所有消息都超时"，
而代码看起来完全正常。

### 5.2 构建失败不能缓存 rejected promise

```js
globalThis[HOST_KEY] = createHost(chrome).catch((e) => {
  globalThis[HOST_KEY] = null;   // ← 清掉，下次消息能重试
  throw e;
});
```

不清掉的话，一次瞬时失败会让这个 SW 实例永久不可用。

---

## 6. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `lib/storage.js` | 新增 | `chrome.storage.local` 后端、探测、审计、敏感键扫描 |
| `tests/storage.test.js` | 新增 | 21 项 |
| `lib/config.js` | 改 | 命名空间去前缀（修缺陷） |
| `lib/host.js` | 改 | `createHost` 改 async；接入存储探测 |
| `background/service-worker.js` | 改 | 同步注册 + 异步等待宿主；失败可重试 |
| `lib/permissions.js` | 改 | `storage` 能力改名 `configStore`（语义更准） |
| `lib/modules/registry.js` | 改 | 声明 `configStore` |
| `manifest.json` | 改 | 加 `storage`；版本 0.7.0 → 0.8.0 |
| `options/options.js` | 改 | 能力名映射 |
| 四个测试文件 | 改 | 跟随 async `createHost` 与新权限期望 |
| `test/acceptance/run.mjs` | 改 | 加 T12 / T12b / T12c |

### 6.1 能力名从 `storage` 改成 `configStore`

原名叫 `storage`，容易让人以为"可以随便存东西"。
改叫 `configStore` 并配注释说明"只用 local、不用 sync、禁止存敏感数据"，
语义更明确。`manifest` 里的权限名仍然是 `storage`（那是浏览器的叫法）。

`manifest-consistency.test.js` 里有一条断言守着：

```js
assert.deepEqual(host.registry.capabilityOwners('configStore'), ['registry']);
```

只有设置持久化该用这个能力。将来如果有模块也想存东西，这条会红，
提醒开发者"这是一次需要重新审查的决定"。

---

## 7. 测试

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 扩展单元/集成 | **272** | 原 251 + 新增 21 |
| 真实 Chrome | **28** | 全 PASS |
| Rust | 241 | 本轮未改 Rust |

`storage.test.js` 的重点分布：

| 类别 | 条数 | 关注点 |
| --- | --- | --- |
| 后端行为 | 6 | 脏值拒绝、前缀隔离、不误删别人的键 |
| 后退路径 | 5 | 无权限/API 抛错/写入被丢弃 都能退回内存 |
| 与配置中心集成 | 3 | **模拟 SW 重启**、不信任存储、secret 键读不进 |
| 审计 | 4 | 列举不泄露值、敏感键扫描（含嵌套） |

---

## 8. 数据保护与清理

| 项 | 测试前 | 测试后 |
| --- | --- | --- |
| 真实 `vault.dat` | `42228` B / md5 `2bd94cde…` | **完全一致** |
| 真实 `bridge.key` | 不存在 | **不存在** |
| Chrome / Edge 注册项 | `False` / `False` | **`False` / `False`** |
| 扩展存储内容 | — | 仅 `keynest.cfg.adblock`（测试写入，已清除） |
| 临时 profile | — | **已删除**（存储随之消失） |
| 遗留进程 | — | **0** |

**存储里从未出现过密码、密钥、nonce、cookie**：T12b 实测 `hits: []`。

---

## 9. 已知限制（如实）

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | 配置仍有内存缓存 | `ConfigCenter.#cache` 在 SW 实例内缓存。多上下文（popup 与 SW）各自一份缓存，**没有跨上下文失效通知**。若将来用户在 options 改设置而 SW 已缓存旧值，会短暂不一致。当前靠每次 `load()` 刷新规避 |
| 2 | 未做 `storage.onChanged` 监听 | 同上。加它要处理"自己写的也触发"的回环，留到有实际需求时 |
| 3 | 存储配额未处理 | `storage.local` 有 10MB 上限。当前只存几个枚举值，远未接近；将来存笔记类数据要提前规划 |
| 4 | 未做导入/导出配置 | 用户换机时设置要重设。属于产品功能，不是架构问题 |
| 5 | 存储加密 | `storage.local` 是明文的。里面只有"广告档位"这类非敏感设置，所以可接受；**若将来要存敏感数据，必须先做加密，不能直接往里写** |

---

## 10. 停止点

**阶段 3.0 完成，已停止。**

- 未推送、未合并、未发布
- main 与 v0.4.3 未动
- 未注册 Edge
- 真实库与真实 bridge.key 未触碰
- 临时环境已完全清理

**下一步**（按 `docs/ROADMAP.md` 的 A 类）：
A2 popup 承载多模块入口、A3 按站点快速暂停 UI。
两者都是"已实现的能力缺一个用户入口"，不需要新的权限。
