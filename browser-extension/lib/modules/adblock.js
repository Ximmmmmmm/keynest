// 「广告与跟踪器过滤」模块。
//
// # 这是第一个真正的功能模块
//
// 它的价值不只是"能拦广告"，更是**验证阶段 2.8 立的骨架够不够用**：
// 新的 manifest 权限、动态规则集、按站点豁免——这三件事骨架都得撑住。
//
// # 三个刻意的取舍
//
// **① 用 declarativeNetRequest，不用 webRequest。**
// MV3 不给普通扩展 `webRequestBlocking`；而且 dNR 由浏览器内核匹配，
// 每条请求不过 JS，性能与隐私都更好（扩展看不到请求内容）。
//
// **② 不做元素隐藏（cosmetic filtering）。**
// 那需要往每个页面注入 CSS，出错的表现是"网站布局塌了"，
// 比漏几个广告严重得多。留到单独阶段，且要能一键关。
//
// **③ 豁免名单优先于拦截。**
// 用户点"在此站暂停"必须立刻生效，不能等规则重算。
// 实现上用 `allowAllRequests` 规则，优先级高于所有 block 规则。
// 这是唯一允许生成的放行规则类型，且绑定到用户显式选择的主 frame 域名。

import { buildRuleset, explainHost, MODES } from '../filters/rules.js';
import { normalizeDomain } from '../filters/domain.js';

/** 动态规则集的固定 id。一个扩展只能有一个同名规则集。 */
export const RULESET_ID = 'keynest_adblock';

/** 豁免规则的 id 段。与拦截规则错开，避免冲突。 */
export const ALLOW_RULE_ID_BASE = 9000;

/**
 * 建广告过滤模块。
 *
 * @param {object} deps
 * @param {object} deps.dnr  `chrome.declarativeNetRequest`（测试注入假实现）
 * @param {(cb:Function)=>void} [deps.onRuleMatched] 订阅 onRuleMatchedDebug（仅开发期可用）
 */
export function createAdblockModule(deps) {
  /** 上一次成功安装的档位，用于避免无意义的重复安装。 */
  let installedMode = null;
  /** 上次安装的错误，供设置页显示。 */
  let lastError = null;

  const dnr = deps.dnr;

  /**
   * 安装某个档位的规则。
   *
   * 三件事必须做对：
   *
   *   1. **先更新再删旧** 的反过来——dNR 要求 `updateDynamicRules` 里
   *      `removeRuleIds` 与 `addRules` 是同一次原子操作，不能分两次调用，
   *      否则中间会有一段"规则为空"的窗口，用户能感知到广告闪一下。
   *   2. **失败要能回退**。安装失败时不能留下"半套规则"，
   *      也不能把 lastError 吞掉——用户会看到"开了但没拦住"。
   *   3. **档位没变就不动**。SW 每次唤醒都会跑一遍，无脑重装会拖慢唤醒。
   *
   * @param {'off'|'basic'|'strict'} mode
   * @param {ReadonlyArray<string>} [allowDomains] 用户显式豁免的主 frame 域名
   */
  async function applyRules(mode, allowDomains = []) {
    if (!MODES.includes(mode)) {
      lastError = 'BAD_MODE';
      return { ok: false, error: 'BAD_MODE' };
    }

    const { block, redirect } = buildRuleset(mode);
    const allowRules = buildAllowRules(allowDomains);
    const addRules = [...allowRules, ...block, ...redirect];

    // 先算出要删哪些 id：现有动态规则的全部 id
    let existing = [];
    try {
      existing = await dnr.getDynamicRules();
    } catch (e) {
      lastError = 'DNR_UNAVAILABLE';
      return { ok: false, error: 'DNR_UNAVAILABLE' };
    }
    const removeRuleIds = existing.map((r) => r.id);

    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules });
      installedMode = mode;
      lastError = null;
      return { ok: true, mode, rules: addRules.length, allow: allowRules.length };
    } catch (e) {
      // 安装失败：把错误码记下来，让设置页能显示。
      // 绝不静默——否则用户只会觉得"这个功能没用"。
      lastError = classifyDnrError(e);
      return { ok: false, error: lastError };
    }
  }

  /**
   * 生成豁免规则。
   *
   * `allowAllRequests` 只对 `main_frame` / `sub_frame` 有效，且作用于
   * 该请求发起的**整棵子资源树**。这正是我们要的语义：
   * 用户在 example.com 点"暂停"，该页面上所有请求都不拦。
   *
   * 域名的合法性在这里**再校验一次**：调用方可能从存储里读回脏数据。
   */
  function buildAllowRules(domains) {
    const rules = [];
    let id = ALLOW_RULE_ID_BASE;
    for (const raw of domains) {
      const d = normalizeDomain(raw);
      if (!d) continue;
      rules.push({
        id: id++,
        // 优先级必须高于所有 block 规则（block 最高是 2）
        priority: 100,
        action: { type: 'allowAllRequests' },
        condition: {
          requestDomains: [d],
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      });
    }
    return rules;
  }

  /** 把 dNR 的原生错误转成稳定错误码。 */
  function classifyDnrError(e) {
    const msg = String((e && e.message) || '');
    // Chrome 实际的措辞是 "does not have a unique ID"，不是 "duplicate"——
    // 只按 duplicate 匹配会漏掉真实场景，错误码就永远落到 DNR_FAILED。
    if (/duplicate|already exists|unique ID/i.test(msg)) return 'RULE_ID_CONFLICT';
    if (/permission|not allowed/i.test(msg)) return 'DNR_PERMISSION';
    if (/invalid|bad rule/i.test(msg)) return 'RULE_INVALID';
    return 'DNR_FAILED';
  }

  /** 诊断：为什么这个 host 被/没被拦。 */
  function explain(host, mode) {
    return explainHost(host, mode);
  }

  return {
    id: 'adblock',
    title: '广告与跟踪器过滤',
    description: '按域名拦截广告与跟踪请求；可在单个站点暂停',
    // 默认关闭：这是一个会改变网页行为的模块，应当由用户主动开启。
    // 密码填充那种"扩展的核心意义"才适合默认开启。
    defaultEnabled: false,
    requires: ['declarativeNetRequest', 'hostHttps'],
    config: {
      mode: {
        type: 'enum',
        values: [...MODES],
        default: 'basic',
      },
    },
    handlers: [
      {
        type: 'adblock.apply',
        handle: async (msg, ctx) => {
          const mode = msg.mode ?? ctx.config.get('mode');
          const allow = Array.isArray(msg.allowDomains) ? msg.allowDomains : [];
          const res = await applyRules(mode, allow);
          if (!res.ok) return res;
          // 把档位记回配置：否则下次 `ctx.config.get('mode')` 还是旧值，
          // 表现是「切到 strict，刷新设置页又变回 basic」。
          // 只有真正安装成功才写——安装失败时改配置会让两者不一致。
          if (msg.mode !== undefined) await ctx.config.set('mode', msg.mode);
          return { ok: true, ...res };
        },
      },
      {
        type: 'adblock.explain',
        handle: (msg, ctx) => {
          const host = typeof msg.host === 'string' ? msg.host : '';
          if (!host) return { ok: false, error: 'BAD_ARGS' };
          return { ok: true, ...explain(host, ctx.config.get('mode')) };
        },
      },
      {
        type: 'adblock.status',
        handle: () => ({
          ok: true,
          mode: installedMode,
          lastError,
        }),
      },
    ],
    /**
     * 供宿主在启用/禁用/配置变更时调用。
     *
     * 不用下划线前缀：这是**正式 API**，宿主真的会调它。
     * 带下划线的"私有"约定在跨模块调用里只会误导人。
     */
    applyRules,
  };
}
