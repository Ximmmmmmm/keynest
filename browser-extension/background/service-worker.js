// Service Worker：扩展里**唯一**持有 Native Messaging 端口的地方。
//
// 三条不变式（改动这个文件前请先读）：
//   1. 只有这里能 `connectNative`。content script 永远拿不到端口。
//   2. 密码只在本函数的局部变量里短暂存在，绝不写 storage、绝不进日志。
//   3. 填充授权是一次性、短时效、绑定 tab/frame/origin/entry 的**状态机**，
//      不是"创建完就删掉"的摆设。

import { normalize, isFillable } from '../lib/origin.js';
import { AuthStore } from '../lib/auth-store.js';
import { classifySender as classify } from '../lib/sender.js';

const HOST_NAME = 'com.keynest.bridge';
const PROTOCOL_VERSION = 1;

/** 授权有效期：用户点完到真正兑换，中间只该隔几十毫秒。 */
const AUTH_TTL_MS = 5000;

/**
 * 扩展自己的页面（popup / options）的 URL 前缀。
 * `chrome.runtime.getURL('')` 返回 `chrome-extension://<id>/`。
 * 这是**固定前缀**，不是用户可控字符串，所以用它做前缀判断是安全的；
 * 但 origin 比较绝不用前缀（见 lib/origin.js）。
 */
const EXT_BASE = chrome.runtime.getURL('');

/** 允许作为"特权 UI"的扩展页面路径白名单。 */
const PRIVILEGED_PAGES = ['popup/popup.html'];

/** @type {chrome.runtime.Port|null} */
let port = null;
let inflight = new Map(); // id -> {resolve, reject, timer}
let seq = 0;

/**
 * 填充授权状态机（实现在 lib/auth-store.js，SW 只是持有实例）。
 *
 * 抽出去的原因：授权"只能用一次"这件事必须能被自动化测试覆盖，
 * 而 SW 依赖 chrome.* API 无法在 node 里直接跑。
 * SW 引用的是**同一份**状态机代码，不是复制品。
 */
const auths = new AuthStore(() => Date.now(), AUTH_TTL_MS);

function nextId() {
  seq += 1;
  return `r${Date.now().toString(36)}-${seq}`;
}

function cryptoNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Native Messaging                                                    */
/* ------------------------------------------------------------------ */

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
    port = null;
    // 断连时所有授权一律作废：不能让"KeyNest 已经没了"的授权继续可用
    auths.clear();
    for (const [, p] of inflight) {
      clearTimeout(p.timer);
      p.reject(new Error('HOST_DISCONNECTED'));
    }
    inflight.clear();
  });

  return port;
}

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

/* ------------------------------------------------------------------ */
/* 消息来源分类                                                        */
/* ------------------------------------------------------------------ */

/**
 * 判定消息来自哪一类上下文（实现在 lib/sender.js，可单独测试）。
 *
 * **不再用 `sender.tab` 存在与否作为身份判据**——`options_ui` 在标签页里
 * 打开时它也存在。判据改为 sender.id + sender.url 的精确分类。
 */
function classifySender(sender) {
  return classify(sender, {
    extensionId: chrome.runtime.id,
    extensionBase: EXT_BASE,
    privilegedPages: PRIVILEGED_PAGES,
  });
}

/* ------------------------------------------------------------------ */
/* 授权状态机                                                          */
/* ------------------------------------------------------------------ */


/**
 * 创建授权。**不取密码**——密码要等到 redeem 通过校验后才取。
 * @returns {{nonce: string}}
 */
function issueAuth({ tabId, frameId, origin, entryId, username }) {
  const nonce = cryptoNonce();
  auths.issue(nonce, { tabId, frameId, origin, entryId, username });
  return { nonce };
}

/**
 * 兑换授权：校验通过则转为 consuming 并返回授权记录，否则返回 null。
 *
 * 校验项（顺序固定）：
 *   1. nonce 存在且状态为 issued
 *   2. 未过期
 *   3. 调用方声明的 tab/frame/origin/entry 与授权记录一致
 *   4. tab 仍然存在，且**重新取到的浏览器 URL** 规范化后与授权 origin 精确相等
 *   5. frameId 匹配
 *
 * 任何一项失败都立即删除授权（不留可重试的机会）。
 */
async function redeemAuth(nonce, claimed) {
  // 先确认记录存在（避免为一个不存在的 nonce 去调 chrome.tabs.get）
  const rec = auths.peek(nonce);
  if (!rec) return null;

  // 用浏览器侧的真实 URL 重新校验 origin：不信任消息里传来的任何地址
  let tab;
  try {
    tab = await chrome.tabs.get(rec.tabId);
  } catch (e) {
    auths.invalidate(nonce);
    return null;
  }
  const liveOrigin = normalize(tab.url || '');
  if (!liveOrigin || liveOrigin !== rec.origin) {
    auths.invalidate(nonce);
    return null;
  }

  // 交给状态机做剩余校验（绑定值、过期、重放）并推进状态
  return auths.beginRedeem(nonce, claimed);
}

function consumeAuth(nonce) {
  auths.consume(nonce);
}

/* ------------------------------------------------------------------ */
/* 生命周期钩子：导航 / tab 关闭 / 重启 都要让旧授权失效               */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  auths.invalidateTab(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  // 任何一次主框架导航都让该 tab 的授权失效
  auths.invalidateNavigation(details.tabId, details.frameId);
});

// Service Worker 每次启动都是新的执行环境：内存里的 auths 天然为空，
// 旧授权不可能被"恢复"。这里显式清一次，表明这是有意为之而非巧合。
auths.clear();

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const kind = classifySender(sender);

  if (!msg || typeof msg.type !== 'string') {
    sendResponse({ ok: false, error: 'BAD_MESSAGE' });
    return false;
  }

  if (msg.type === 'status') {
    request('status', {})
      .then((p) => sendResponse({ ok: true, data: p }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'query') {
    if (kind !== 'popup') {
      sendResponse({ ok: false, error: 'PRIVILEGED_ONLY' });
      return false;
    }
    handleQuery(msg.tabId).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  // 第一步：用户点了条目 → 只签发授权，**不取密码**
  if (msg.type === 'authorize-fill') {
    if (kind !== 'popup') {
      sendResponse({ ok: false, error: 'PRIVILEGED_ONLY' });
      return false;
    }
    handleAuthorize(msg).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  // 第二步：content script 出示 nonce 兑换密码
  if (msg.type === 'redeem-fill') {
    if (kind !== 'content') {
      sendResponse({ ok: false, error: 'CONTENT_ONLY' });
      return false;
    }
    handleRedeem(msg, sender).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  if (msg.type === 'content-ready') {
    if (kind !== 'content') {
      sendResponse({ ok: false, error: 'BAD_SENDER' });
      return false;
    }
    sendResponse({ ok: true });
    return false;
  }

  sendResponse({ ok: false, error: 'UNKNOWN_TYPE' });
  return false;
});

/* ------------------------------------------------------------------ */
/* 处理函数                                                            */
/* ------------------------------------------------------------------ */

async function handleQuery(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = normalize(tab.url || '');
  if (!origin) return { ok: false, error: 'NO_ORIGIN' };
  if (!isFillable(origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

  const list = await request('vault.query', { origin });
  return { ok: true, origin, entries: Array.isArray(list) ? list : [] };
}

/** 签发授权并把 nonce 交给 content script（**不含密码**）。 */
async function handleAuthorize(msg) {
  const tabId = msg.tabId;
  const entryId = String(msg.entryId || '');
  if (!Number.isInteger(tabId) || !entryId) return { ok: false, error: 'BAD_ARGS' };

  const tab = await chrome.tabs.get(tabId);
  const origin = normalize(tab.url || '');
  if (!origin) return { ok: false, error: 'NO_ORIGIN' };
  if (!isFillable(origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

  // 先向 KeyNest 复查条目是否属于该 origin（不取密码，只查元数据）
  const list = await request('vault.query', { origin });
  if (!Array.isArray(list) || !list.some((e) => e.id === entryId)) {
    return { ok: false, error: 'ENTRY_NOT_MATCHED' };
  }

  const frameId = 0;
  const username = typeof msg.username === 'string' ? msg.username.slice(0, 320) : '';
  const { nonce } = issueAuth({ tabId, frameId, origin, entryId, username });

  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'prepare-fill', nonce, origin },
      { frameId }
    );
  } catch (e) {
    auths.invalidate(nonce);
    return { ok: false, error: 'NO_CONTENT_SCRIPT' };
  }

  return { ok: true, nonce };
}

/** content script 兑换：验证授权 → 取密码 → 下发 → 消费。 */
async function handleRedeem(msg, sender) {
  const nonce = typeof msg.nonce === 'string' ? msg.nonce : '';
  if (!nonce) return { ok: false, error: 'NO_NONCE' };

  const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const senderOrigin = normalize(sender.url || '');

  const a = await redeemAuth(nonce, {
    tabId: sender.tab && sender.tab.id,
    frameId,
    origin: senderOrigin,
    entryId: msg.entryId,
  });
  if (!a) return { ok: false, error: 'AUTH_REJECTED' };

  // 到这里授权已转为 consuming，同一个 nonce 不可能再兑换第二次
  let res;
  try {
    res = await request('vault.fill', {
      entry_id: a.entryId,
      origin: a.origin,
      confirm: nonce, // 把授权 nonce 作为一次性确认串交给 GUI 侧留痕
    });
  } catch (e) {
    auths.invalidate(nonce);
    return { ok: false, error: String(e.message || 'FILL_FAILED') };
  }

  const password = res && res.password;
  if (typeof password !== 'string' || !password) {
    auths.invalidate(nonce);
    return { ok: false, error: 'NO_PASSWORD' };
  }

  // 直接回给发起兑换的 content script（同一个 frame），不入 storage、不写日志
  consumeAuth(nonce);
  return { ok: true, username: a.username, password };
}
