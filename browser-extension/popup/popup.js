// Popup —— 扩展的特权 UI。
//
// 它是整个流程里唯一能发起 `fill` 的上下文：用户必须**在这里点一下**。
// 网页无法点击 popup，content script 也没有权限伪造这类消息。

const els = {
  status: document.getElementById('status'),
  locked: document.getElementById('locked-note'),
  listSection: document.getElementById('list-section'),
  list: document.getElementById('entries'),
  empty: document.getElementById('empty'),
  error: document.getElementById('error'),
  refresh: document.getElementById('refresh'),
  openOptions: document.getElementById('open-options'),

  adblockSection: document.getElementById('adblock-section'),
  adblockState: document.getElementById('adblock-state'),
  adblockHost: document.getElementById('adblock-host'),
  adblockToggle: document.getElementById('adblock-toggle'),
  adblockNote: document.getElementById('adblock-note'),
};

/** 当前标签页的 id，页面上所有操作都以它为准。 */
let currentTabId = null;

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `badge ${cls || ''}`.trim();
}

function setError(text) {
  if (!text) { hide(els.error); return; }
  els.error.textContent = text;
  show(els.error);
}

function escapeText(s) {
  // 用 textContent 赋值即可，这里只做类型兜底
  return typeof s === 'string' ? s : '';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab && tab.id;
  currentTabUrl = tab && tab.url;
  await refresh();
  await refreshAdblock();
}

/**
 * 当前标签页的 URL。
 *
 * 注意：没有 tabs 权限时这个值是 undefined——**这不是错误**，
 * 广告过滤那一段会自行退化为"不显示站点信息但按钮仍可用"（见下）。
 * 密码填充本来就只用 getFrame 取 origin，不依赖这里。
 */
let currentTabUrl = null;

async function refresh() {
  hide(els.listSection);
  hide(els.empty);
  hide(els.locked);
  setError('');

  if (!Number.isInteger(currentTabId)) {
    setStatus('无法读取标签页', 'bad');
    return;
  }

  // 1. KeyNest 是否在线、是否解锁
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  if (!status || !status.ok) {
    setStatus('未连接', 'bad');
    show(els.locked);
    return;
  }
  if (status.data.locked) {
    setStatus('已锁定', 'bad');
    show(els.locked);
    return;
  }
  setStatus('已解锁', 'ok');

  // 2. 查询匹配条目（不含密码）
  const res = await chrome.runtime.sendMessage({ type: 'query', tabId: currentTabId });
  if (!res || !res.ok) {
    const map = {
      HTTP_NOT_ALLOWED: '该页面不是 HTTPS，已按策略禁止填充。',
      NO_ORIGIN: '这个页面没有可用的网址。',
      VAULT_LOCKED: 'KeyNest 已锁定。',
      TIMEOUT: 'KeyNest 没有响应。',
      HOST_DISCONNECTED: '与 KeyNest 的连接已断开。',
    };
    setError(map[res && res.error] || `查询失败：${(res && res.error) || '未知错误'}`);
    return;
  }

  if (!res.entries.length) {
    show(els.empty);
    return;
  }

  els.list.replaceChildren();
  for (const entry of res.entries) {
    const li = document.createElement('li');
    li.dataset.entryId = entry.id;
    li.dataset.username = entry.username || '';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = escapeText(entry.title);

    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = escapeText(entry.username);

    li.append(title, user);
    li.addEventListener('click', () => doFill(entry.id, entry.username));
    els.list.append(li);
  }
  show(els.listSection);
}

/**
 * 唯一会取密码的动作：必须由用户点击触发。
 *
 * 两段式：
 *   1. `authorize-fill` —— SW 校验后签发一次性授权，把 nonce 交给 content script（**不含密码**）
 *   2. `redeem-now`     —— content script 出示 nonce 兑换，SW 重新校验 tab/origin 后才给密码
 *
 * popup 全程**拿不到密码**，也拿不到可用的授权令牌。
 */
async function doFill(entryId, username) {
  setError('');
  els.list.replaceChildren();

  const auth = await chrome.runtime.sendMessage({
    type: 'authorize-fill',
    tabId: currentTabId,
    entryId,
    username: typeof username === 'string' ? username : '',
  });

  if (!auth || !auth.ok) {
    const map = {
      HTTP_NOT_ALLOWED: '该页面不是 HTTPS，拒绝填充。',
      ORIGIN_MISMATCH: '页面地址与条目不一致，已阻止填充。',
      ENTRY_NOT_MATCHED: '该条目不属于当前网站。',
      NO_CONTENT_SCRIPT: '无法与页面通信，请刷新页面后重试。',
      VAULT_LOCKED: 'KeyNest 刚刚被锁定，已拒绝填充。',
      TIMEOUT: 'KeyNest 没有响应。',
    };
    setError(map[auth && auth.error] || `填充失败：${(auth && auth.error) || '未知错误'}`);
    await refresh();
    return;
  }

  // 触发 content script 兑换（content script 持有 nonce，popup 不持有）
  let done = null;
  try {
    done = await chrome.tabs.sendMessage(
      currentTabId,
      { type: 'redeem-now', entryId },
      { frameId: 0 }
    );
  } catch (e) {
    setError('无法与页面通信，请刷新页面后重试。');
    await refresh();
    return;
  }

  if (!done || !done.ok) {
    const map = {
      AUTH_REJECTED: '授权校验未通过（可能页面已跳转或授权已过期）。',
      NO_FORM: '这个页面没有找到登录表单。',
      NO_PASSWORD: '条目里没有密码。',
      VAULT_LOCKED: 'KeyNest 已锁定，已拒绝填充。',
      REDEEM_FAILED: '兑换授权失败。',
    };
    setError(map[done && done.error] || `填充失败：${(done && done.error) || '未知错误'}`);
    await refresh();
    return;
  }

  // 填充成功后立即关闭 popup：不给"密码还留在界面里"的机会
  window.close();
}

els.refresh.addEventListener('click', refresh);
document.addEventListener('DOMContentLoaded', init);
init();

/* ------------------------------------------------------------------ */
/* 广告过滤：按站点暂停                                                */
/* ------------------------------------------------------------------ */

/** 从 URL 里取 host。非 http(s) 返回 null。 */
function hostOfUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 渲染广告过滤那一段。
 *
 * # 为什么失败时整段隐藏而不是显示错误
 *
 * 广告过滤默认关闭。对一个只用密码填充的用户来说，这里显示一段
 * "广告过滤不可用"只会造成困惑——他根本没启用这个功能。
 * 所以：模块没启用就整段不出现；启用了但查询失败才显示错误。
 */
async function refreshAdblock() {
  const host = hostOfUrl(currentTabUrl);

  // 先问模块有没有启用（modules.list 是安全的只读接口）
  let enabled = false;
  try {
    const list = await chrome.runtime.sendMessage({ type: 'modules.list' });
    const m = list && list.ok ? (list.modules || []).find((x) => x.id === 'adblock') : null;
    enabled = !!(m && m.enabled);
  } catch {
    enabled = false;
  }

  if (!enabled || !host) {
    hide(els.adblockSection);
    return;
  }

  const status = await chrome.runtime.sendMessage({ type: 'adblock.status' });
  if (!status || !status.ok) {
    hide(els.adblockSection);
    return;
  }

  const check = await chrome.runtime.sendMessage({ type: 'adblock.check', host });
  const allowed = !!(check && check.ok && check.allowed);

  show(els.adblockSection);
  els.adblockHost.textContent = host;

  if (status.mode === 'off' || status.mode === null) {
    els.adblockState.textContent = '未生效';
    els.adblockState.className = 'badge';
    els.adblockToggle.disabled = true;
    els.adblockToggle.textContent = '过滤已关闭（在设置里开启）';
    return;
  }

  els.adblockToggle.disabled = false;
  if (allowed) {
    els.adblockState.textContent = '本站已暂停';
    els.adblockState.className = 'badge bad';
    els.adblockToggle.textContent = '恢复本站过滤';
  } else {
    els.adblockState.textContent = '本站已启用';
    els.adblockState.className = 'badge ok';
    els.adblockToggle.textContent = '在此站暂停过滤';
  }

  els.adblockToggle.onclick = async () => {
    els.adblockToggle.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: allowed ? 'adblock.disallow' : 'adblock.allow',
      domain: host,
    });
    els.adblockToggle.disabled = false;
    if (!res || !res.ok) {
      setError(`操作失败：${(res && res.error) || '未知错误'}`);
      return;
    }
    setError('');
    els.adblockNote.textContent = allowed
      ? '已恢复过滤，刷新页面后生效'
      : '已暂停过滤，刷新页面后生效';
    els.adblockNote.classList.remove('hidden');
    await refreshAdblock();
  };
}

els.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
