// 兑换流程（可注入依赖，因此可在 node 里做真并发测试）。
//
// Service Worker 里只负责把 chrome.* 的真实实现注入进来；
// 这里的逻辑是**实际运行的那份**，不是测试用的仿制品。

import { normalize } from './origin.js';

/**
 * @typedef {object} Deps
 * @property {(tabId:number) => Promise<{url?:string}>} getTab
 * @property {(d:{tabId:number, frameId:number}) => Promise<{url?:string}>} getFrame
 * @property {(req:object) => Promise<{password?:string}>} fill
 */

/**
 * 兑换并取密码。
 *
 * 并发安全的核心：`auths.claim()` 同步执行，**在任何 await 之前**。
 * 100 个并发调用里只有第一个能通过 claim，其余立即返回 null，
 * 不会触发任何 getFrame / getTab / fill 调用。
 *
 * @param {import('./auth-store.js').AuthStore} auths
 * @param {Deps} deps
 * @param {string} nonce
 * @param {{tabId:number, frameId:number, origin:string, entryId:string}} claimed
 * @returns {Promise<{ok:true, username:string, password:string} | {ok:false, error:string}>}
 */
export async function redeemFill(auths, deps, nonce, claimed) {
  // ---- 同步认领：唯一的并发入口 ----
  const rec = auths.claim(nonce, claimed);
  if (!rec) return { ok: false, error: 'AUTH_REJECTED' };

  // ---- 取该 frame 的真实 URL（浏览器可信数据）----
  let frameInfo;
  try {
    frameInfo = await deps.getFrame({ tabId: rec.tabId, frameId: rec.frameId });
  } catch (e) {
    auths.invalidate(nonce);
    return { ok: false, error: 'FRAME_GONE' };
  }
  if (!frameInfo || typeof frameInfo.url !== 'string') {
    auths.invalidate(nonce);
    return { ok: false, error: 'FRAME_GONE' };
  }

  const frameOrigin = normalize(frameInfo.url);
  if (!frameOrigin || frameOrigin !== rec.origin) {
    // iframe 的真实 origin 与授权不符 → 拒绝。这条是 iframe 安全的关键。
    auths.invalidate(nonce);
    return { ok: false, error: 'FRAME_ORIGIN_MISMATCH' };
  }

  // ---- 顶层 tab 必须仍存在，且顶层 origin 也要校验 ----
  let tab;
  try {
    tab = await deps.getTab(rec.tabId);
  } catch (e) {
    auths.invalidate(nonce);
    return { ok: false, error: 'TAB_GONE' };
  }
  if (!tab || typeof tab.url !== 'string') {
    auths.invalidate(nonce);
    return { ok: false, error: 'TAB_GONE' };
  }

  // 顶层 origin 必须等于授权 origin。
  //
  // 当前只授权 frameId === 0（主框架），所以顶层与目标 frame 是同一个文档。
  // 如果将来支持 iframe 填充，这里必须改成：顶层可以是任意 origin，
  // 但 frameOrigin 必须等于授权 origin，且需要在 UI 上明确告知用户
  // "将填充到跨站 iframe"。**在那之前，放宽这条等于打开跨站填充的缺口。**
  const topOrigin = normalize(tab.url);
  if (!topOrigin || topOrigin !== rec.origin) {
    auths.invalidate(nonce);
    return { ok: false, error: 'TOP_ORIGIN_MISMATCH' };
  }

  // ---- 推进 validating → consuming（只在此刻之后才取密码）----
  const confirmed = auths.confirm(nonce);
  if (!confirmed) {
    // 期间被 abort：导航 / tab 关闭 / 断连
    return { ok: false, error: 'AUTH_ABORTED' };
  }

  // ---- 取密码（单次）----
  let res;
  try {
    res = await deps.fill({
      entry_id: confirmed.entryId,
      origin: confirmed.origin,
      confirm: nonce,
    });
  } catch (e) {
    auths.invalidate(nonce);
    return { ok: false, error: String((e && e.message) || 'FILL_FAILED') };
  }

  const password = res && res.password;
  if (typeof password !== 'string' || !password) {
    auths.invalidate(nonce);
    return { ok: false, error: 'NO_PASSWORD' };
  }

  auths.consume(nonce);
  return { ok: true, username: confirmed.username, password };
}
