// 兑换流程（可注入依赖，因此可在 node 里做真并发测试）。
//
// Service Worker 里只负责把 chrome.* 的真实实现注入进来；
// 这里的逻辑是**实际运行的那份**，不是测试用的仿制品。
//
// # 为什么依赖 getFrame 而不是 tabs.get
//
// 真实 Chrome（无 host 权限）里 `chrome.tabs.get(tabId)` **不返回 url 字段**，
// 只有 `{id, status}`。用它取 origin 必然拿到 undefined → NO_ORIGIN。
// `chrome.webNavigation.getFrame()` 则在同样条件下**返回真实 url 与 documentId**。
// 所以 origin 的唯一可信来源是 getFrame，tabs.get 不再参与 origin 判断。

import { normalize } from './origin.js';

/**
 * @typedef {object} Deps
 * @property {(d:{tabId:number, frameId:number}) => Promise<{url?:string, documentId?:string}>} getFrame
 * @property {(req:object) => Promise<{password?:string}>} fill
 */

/**
 * 取某个 frame 的真实 origin 与文档身份。
 *
 * 返回 null 表示无法确认身份——调用方必须拒绝，**不得退回只校验 frameId**。
 *
 * @param {Deps} deps
 * @param {number} tabId
 * @param {number} frameId
 * @returns {Promise<{origin:string, documentId:string} | null>}
 */
export async function resolveFrame(deps, tabId, frameId) {
  let info;
  try {
    info = await deps.getFrame({ tabId, frameId });
  } catch (e) {
    return null; // getFrame 抛异常（frame 已销毁等）
  }
  if (!info || typeof info !== 'object') return null;
  if (typeof info.url !== 'string' || !info.url) return null;
  if (typeof info.documentId !== 'string' || !info.documentId) return null;

  const origin = normalize(info.url);
  if (!origin) return null; // 非 http/https 或无法规范化

  return { origin, documentId: info.documentId };
}

/**
 * 兑换并取密码。
 *
 * 并发安全的核心：`auths.claim()` 同步执行，**在任何 await 之前**。
 * 100 个并发调用里只有第一个能通过 claim，其余立即返回 null，
 * 不会触发任何 getFrame / fill 调用。
 *
 * 身份校验（全部在 claim 之后、fill 之前）：
 *   1. 目标 frame 的 origin 与 documentId
 *   2. 顶层 frame 的 origin 与 documentId
 *   3. 两项 documentId 必须与授权时记录的完全一致（同 origin 导航也能失效）
 *
 * @param {import('./auth-store.js').AuthStore} auths
 * @param {Deps} deps
 * @param {string} nonce
 * @param {{tabId:number, frameId:number, origin:string, entryId:string, documentId?:string, topDocumentId?:string}} claimed
 * @returns {Promise<{ok:true, username:string, password:string} | {ok:false, error:string}>}
 */
export async function redeemFill(auths, deps, nonce, claimed) {
  // ---- 同步认领：唯一的并发入口 ----
  const rec = auths.claim(nonce, claimed);
  if (!rec) return { ok: false, error: 'AUTH_REJECTED' };

  // ---- 目标 frame 身份 ----
  const target = await resolveFrame(deps, rec.tabId, rec.frameId);
  if (!target) {
    auths.invalidate(nonce);
    return { ok: false, error: 'FRAME_GONE' };
  }
  if (target.origin !== rec.origin) {
    auths.invalidate(nonce);
    return { ok: false, error: 'FRAME_ORIGIN_MISMATCH' };
  }
  if (target.documentId !== rec.documentId) {
    // 同 origin 但换了文档（导航）→ 旧授权必须失效
    auths.invalidate(nonce);
    return { ok: false, error: 'DOCUMENT_CHANGED' };
  }

  // ---- 顶层 frame 身份 ----
  const top = await resolveFrame(deps, rec.tabId, 0);
  if (!top) {
    auths.invalidate(nonce);
    return { ok: false, error: 'TOP_FRAME_GONE' };
  }
  if (top.documentId !== rec.topDocumentId) {
    auths.invalidate(nonce);
    return { ok: false, error: 'TOP_DOCUMENT_CHANGED' };
  }
  // 当前只授权 frameId === 0，所以顶层与目标是同一文档；
  // 将来支持 iframe 填充时必须重新审视这条（见架构文档）。
  if (top.origin !== rec.origin) {
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
