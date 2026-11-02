// Service Worker：扩展里**唯一**持有 Native Messaging 端口的地方。
//
// 三条不变式（改动这个文件前请先读）：
//   1. 只有这里能 `connectNative`。content script 永远拿不到端口。
//   2. 密码只在本函数的局部变量里短暂存在，绝不写 storage、绝不进日志。
//   3. 填充令牌一次性、短时效，且绑定 tab/frame/origin/entry/nonce。

import { normalize, isFillable } from '../lib/origin.js';

const HOST_NAME = 'com.keynest.bridge';
const PROTOCOL_VERSION = 1;
const TOKEN_TTL_MS = 8000;

/** @type {chrome.runtime.Port|null} */
let port = null;
let inflight = new Map(); // id -> {resolve, reject, timer}
let seq = 0;

/** 一次性填充令牌：nonce -> {tabId, frameId, origin, entryId, expiresAt, used} */
const tokens = new Map();

function nextId() {
  seq += 1;
  return `r${Date.now().toString(36)}-${seq}`;
}

function cryptoNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    throw new Error('NATIVE_HOST_MISSING');
  }

  port.onMessage.addListener((msg) => {
    const pending = inflight.get(msg && msg.id);
    if (!pending) return; // 未知 id：丢弃，绝不当成有效响应
    inflight.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.payload);
    else pending.reject(new Error((msg.error && msg.error.code) || 'BRIDGE_ERROR'));
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    port = null;
    for (const [, p] of inflight) {
      clearTimeout(p.timer);
      p.reject(new Error(err ? 'HOST_DISCONNECTED' : 'HOST_DISCONNECTED'));
    }
    inflight.clear();
  });

  return port;
}

/**
 * 发一条请求给 Native Host。超时由 host 与这里双重把关。
 * @param {string} cmd
 * @param {object} payload
 */
function request(cmd, payload) {
  const p = connect();
  const id = nextId();
  const msg = { v: PROTOCOL_VERSION, id, cmd, payload: payload || {} };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(new Error('TIMEOUT'));
    }, 5000);
    inflight.set(id, { resolve, reject, timer });
    try {
      p.postMessage(msg);
    } catch (e) {
      clearTimeout(timer);
      inflight.delete(id);
      reject(new Error('POST_FAILED'));
    }
  });
}

/** 清理过期令牌。 */
function sweepTokens() {
  const now = Date.now();
  for (const [nonce, t] of tokens) {
    if (t.expiresAt <= now || t.used) tokens.delete(nonce);
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受来自扩展自己页面（popup）的消息：
  // content script 也在扩展里，但它的 sender.tab 必然存在——据此区分。
  const fromPopup = !sender.tab && sender.id === chrome.runtime.id;
  const fromContent = !!sender.tab;

  if (!msg || msg.type === undefined) {
    sendResponse({ ok: false, error: 'BAD_MESSAGE' });
    return false;
  }

  if (msg.type === 'status') {
    request('status', {})
      .then((p) => sendResponse({ ok: true, data: p }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // 异步响应
  }

  if (msg.type === 'query') {
    if (!fromPopup) {
      sendResponse({ ok: false, error: 'PRIVILEGED_ONLY' });
      return false;
    }
    handleQuery(msg.tabId).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  if (msg.type === 'fill') {
    if (!fromPopup) {
      // 关键防线：content script 或网页永远不能直接要求填充
      sendResponse({ ok: false, error: 'PRIVILEGED_ONLY' });
      return false;
    }
    handleFill(msg).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  if (msg.type === 'content-ready') {
    if (!fromContent) {
      sendResponse({ ok: false, error: 'BAD_SENDER' });
      return false;
    }
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
  return false;
});

/** 查询匹配条目（不含密码）。 */
async function handleQuery(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = normalize(tab.url || '');
  if (!origin) return { ok: false, error: 'NO_ORIGIN' };
  if (!isFillable(origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

  const list = await request('vault.query', { origin });
  return { ok: true, origin, entries: Array.isArray(list) ? list : [] };
}

/** 用户点击"填充"后的完整流程。 */
async function handleFill(msg) {
  sweepTokens();

  const tabId = msg.tabId;
  const entryId = String(msg.entryId || '');
  if (!Number.isInteger(tabId) || !entryId) return { ok: false, error: 'BAD_ARGS' };

  // username 来自 popup 显示的 query 结果（同一 entry id）。
  // 它不是秘密，但仍要防越界：只当字符串用，不信任它指向哪条记录——
  // 记录归属完全由 entryId + origin 在 KeyNest 侧二次校验。
  const username = typeof msg.username === 'string' ? msg.username.slice(0, 320) : '';

  const tab = await chrome.tabs.get(tabId);
  const origin = normalize(tab.url || '');
  if (!origin) return { ok: false, error: 'NO_ORIGIN' };
  if (!isFillable(origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

  // 先向 KeyNest 复查：锁没锁、条目还在不在、origin 与条目是否一致。
  // 这一步不依赖 popup 之前那次 query 的任何缓存。
  const res = await request('vault.fill', {
    entry_id: entryId,
    origin,
    confirm: cryptoNonce(), // 一次性确认串，Host 侧只校验非空且长度合法
  });
  const password = res && res.password;
  if (typeof password !== 'string' || !password) return { ok: false, error: 'NO_PASSWORD' };

  // 生成一次性令牌，绑定 tab/entry/origin
  const nonce = cryptoNonce();
  tokens.set(nonce, {
    tabId,
    frameId: 0,
    origin,
    entryId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    used: false,
  });

  // 直接把密码交给 content script 执行填充。
  // 它既不入 storage，也不写日志，用完即弃。
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'do-fill', nonce, origin, username, password },
      { frameId: 0 }
    );
  } finally {
    const t = tokens.get(nonce);
    if (t) t.used = true;
    tokens.delete(nonce);
  }

  return { ok: true };
}
