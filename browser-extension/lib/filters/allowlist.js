// 豁免名单：用户在某个站点点"暂停过滤"后，这份名单要记住。
//
// # 为什么单独一个文件而不是塞进 adblock 模块
//
// 这份名单会被两个地方用：
//   1. `options` 里的「已豁免站点」列表（读、删）
//   2. popup 里的「在此站暂停」按钮（写）
//
// 塞进模块会让模块同时承担"规则计算"与"用户偏好管理"两件事，
// 后者要处理脏数据、上限、去重——都不是规则计算该关心的。
//
// # 硬约束
//
//   - **上限 200 条**。不设上限的话，用户逛得越久名单越长，
//     最终每次安装规则都要遍历几万条，`updateDynamicRules` 直接超时。
//   - **只存规范化后的域名**，不存 URL、不存路径。
//     存 URL 会带来"路径变了还算不算豁免"的歧义，而且会泄露浏览历史。
//   - **去重 + 新加的排前面**（用户刚点的应该在列表顶部）。

import { normalizeDomain } from '../filters/domain.js';

/** 名单上限。超过就丢最旧的。 */
export const MAX_ALLOWLIST = 200;

/**
 * 规范化一条豁免项。返回 null 表示这条不合法、不该进名单。
 *
 * **明确拒绝带协议或路径的输入**，而不是让 `normalizeDomain` 去猜：
 * `https://example.test/` 在 normalizeDomain 眼里会变成 `https`（把 scheme
 * 当成了单个标签），于是名单里出现一条叫 `https` 的豁免项——
 * 它永远匹配不上任何真实站点，而且看起来像"豁免没生效"。
 *
 * 存 URL 还会带来"路径变了还算不算豁免"的歧义，也会泄露浏览历史，
 * 所以入口就把它们挡掉比事后清洗更清楚。
 *
 * @param {unknown} raw
 */
export function normalizeEntry(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('/') || s.includes('://') || s.includes('?') || s.includes('#')) return null;
  return normalizeDomain(s);
}

/**
 * 从配置字符串解析出名单。坏 JSON 当空名单——坏数据不该让功能整体不可用。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAllowlist(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    return sanitizeAllowlist(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * 把任意输入（可能是存储里读出的脏数组）清洗成合法名单。
 *
 * 三件事：逐条规范化、去重、截断到上限。
 * **顺序保持输入顺序**——调用方按"最近在前"存储，这里不该打乱。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeAllowlist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const d = normalizeEntry(item);
    if (!d) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= MAX_ALLOWLIST) break;
  }
  return out;
}

/**
 * 加入一条。已存在则提到最前（用户再点一次"暂停"通常是想确认它还在）。
 *
 * @param {string[]} list 已清洗的名单
 * @param {string} domain
 * @returns {{list: string[], added: boolean, moved: boolean}}
 */
export function addEntry(list, domain) {
  const d = normalizeEntry(domain);
  if (!d) return { list, added: false, moved: false };

  const idx = list.indexOf(d);
  if (idx === 0) {
    // 已经在最前：什么都不用做
    return { list, added: false, moved: false };
  }
  const rest = list.filter((x) => x !== d);
  const next = [d, ...rest];
  // 超出上限时丢最旧的（末尾）
  if (next.length > MAX_ALLOWLIST) next.length = MAX_ALLOWLIST;
  return { list: next, added: idx === -1, moved: idx > 0 };
}

/**
 * 移除一条。
 * @param {string[]} list
 * @param {string} domain
 */
export function removeEntry(list, domain) {
  const d = normalizeEntry(domain);
  if (!d) return { list, removed: false };
  const next = list.filter((x) => x !== d);
  return { list: next, removed: next.length !== list.length };
}

/**
 * 某个 host 是否已被豁免。
 *
 * **按域名归属判断**，不是字符串相等：豁免了 `example.com`，
 * `www.example.com` 也该算豁免——否则用户点了"暂停"，刷新后又开始拦，
 * 因为主站跳到了 www。
 *
 * @param {string[]} list
 * @param {string} host
 */
export function isAllowed(list, host) {
  const h = normalizeDomain(host);
  if (!h) return false;
  for (const d of list) {
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}
