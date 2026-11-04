// 按站点的开关状态：让"夜间模式 / 阅读模式"这类模块记住用户在某站点开过。
//
// # 为什么需要它
//
// 阶段 3.4 结束时夜间模式最大的实用性问题：用户开了，翻一页就没了。
// 因为开关状态只存在于当前页面的 DOM 里，导航后自然消失。
//
// # 为什么复用 allowlist 的规则
//
// 这份数据和 `allowlist.js` 是同一类东西：一组域名 + 上限 + 去重 + 脏数据。
// 但它**不能直接用 allowlist**——语义不同：allowlist 是"不要在这个站点上做事"，
// 这里是"要在这个站点上做事"。混在一起会让两个功能的开关互相串。
//
// 所以这里复用**规则**（域名规范化、上限、标签边界匹配），
// 但存储是各自独立的键。
//
// # 关键设计：按模块分键
//
// 夜间模式和阅读模式各有一份名单。如果共用一个"已开启站点"集合，
// 那么用户在 A 站开夜间模式，A 站的阅读模式也会被自动打上"已开启"。
//
// # 上限：比 allowlist 小
//
// 100 条。理由：这是"我常用的站点"级别的数量，
// 而 allowlist 可能包含大量"临时暂停"的站点，200 更合适。

import { normalizeEntry } from './filters/allowlist.js';

/**
 * 每个模块的站点名单上限。
 *
 * 比 `MAX_ALLOWLIST`(200) 小：这里是"我常用的站点"级别，
 * 而 allowlist 可能包含大量"临时暂停"的站点。
 */
export const MAX_SITE_LIST = 100;

/** 允许按站点记忆的模块。扩这个列表要一起想清楚"覆盖与还原"的语义。 */
export const SITE_SCOPED_MODULES = Object.freeze(['dark', 'reader']);

/** 模块 id → 配置键名。集中在这里避免各处拼字符串。 */
export function configKeyFor(moduleId) {
  if (!SITE_SCOPED_MODULES.includes(moduleId)) {
    throw new Error(`模块 ${moduleId} 不支持按站点记忆`);
  }
  return `${moduleId}Sites`;
}

/**
 * 清洗一份站点名单。
 *
 * 与 `sanitizeAllowlist` 同样的三件事（规范化、去重、截断），
 * 但上限不同，且**顺序保持**（最近开的在前）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeSites(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const d = normalizeEntry(item);
    if (!d) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= MAX_SITE_LIST) break;
  }
  return out;
}

/** 从配置里的 JSON 字符串解析。坏 JSON 当空名单。 */
export function parseSites(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    return sanitizeSites(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * 加入一个站点（提到最前）。
 * @param {string[]} list
 * @param {string} host
 */
export function addSite(list, host) {
  const d = normalizeEntry(host);
  if (!d) return { list, added: false, moved: false };
  if (list[0] === d) return { list, added: false, moved: false };
  const idx = list.indexOf(d);
  const rest = list.filter((x) => x !== d);
  const next = [d, ...rest];
  if (next.length > MAX_SITE_LIST) next.length = MAX_SITE_LIST;
  return { list: next, added: idx === -1, moved: idx > 0 };
}

/** 移除一个站点。 */
export function removeSite(list, host) {
  const d = normalizeEntry(host);
  if (!d) return { list, removed: false };
  const next = list.filter((x) => x !== d);
  return { list: next, removed: next.length !== list.length };
}

/**
 * 某个 host 是否在名单里（按域名归属，子域算）。
 *
 * 与 `isAllowed` 同一套标签边界规则：`www.example.com` 命中 `example.com`，
 * 但 `notexample.com` 不命中。
 *
 * @param {string[]} list
 * @param {string} host
 */
export function hasSite(list, host) {
  const d = normalizeEntry(host);
  if (!d) return false;
  for (const item of list) {
    if (d === item || d.endsWith(`.${item}`)) return true;
  }
  return false;
}

/**
 * 给某个模块建一份"按站点记忆"的读写接口。
 *
 * @param {import('../config.js').ModuleConfig} configView
 * @param {string} moduleId
 */
/**
 * 从调用方给的字符串取规范化后的 host。
 *
 * 不合法就返回 `null`，让调用方退回到「从 tab 的 URL 取」。
 *
 * 放在这里而不是各模块各写一份：规范化规则必须**只有一处**——
 * 两边不一致的话，名单里会出现同��个站点的两种写法，
 * 于是「移除」移不掉、自动应用也判不准。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.includes('/') || s.includes(':')) return null;
  return /^[a-z0-9.-]+$/.test(s) ? s : null;
}

export function createSiteMemory(configView, moduleId) {
  const key = configKeyFor(moduleId);

  return {
    /** 当前名单（已清洗）。 */
    list() {
      return parseSites(configView.get(key));
    },

    /** 某 host 是否已开启。 */
    has(host) {
      return hasSite(this.list(), host);
    },

    /** 开启：写名单。 */
    async enable(host) {
      const cur = this.list();
      const { list, added } = addSite(cur, host);
      if (added || list !== cur) {
        await configView.set(key, JSON.stringify(list));
      }
      return { ok: true, list, changed: added || list !== cur };
    },

    /** 关闭：从名单移除。 */
    async disable(host) {
      const cur = this.list();
      const { list, removed } = removeSite(cur, host);
      if (removed) await configView.set(key, JSON.stringify(list));
      return { ok: true, list, changed: removed };
    },

    /** 清空。 */
    async clear() {
      await configView.set(key, '[]');
      return { ok: true, list: [] };
    },
  };
}
