// 页面注入的共用辅助：申请站点权限 + 执行注入函数。
//
// # 为什么抽出来
//
// 阶段 3.3 写阅读模式时，`scripting` 那条链路踩了两个坑：
//
//   1. `executeScript` 需要**站点权限**，而 manifest 里全站权限是 `optional`，
//      必须先 `permissions.request` 一次。
//   2. `executeScript({func})` 会把函数序列化注入，**不能引用外部变量**。
//
// 第二个坑每个注入模块都要自己处理（各自的注入函数必须自包含，
// 这一点没法抽象）。但第一个坑是**完全可复用**的：
// 每个要在某站点上动手的模块，都要走"查权限 → 按需申请 → 才注入"。
//
// 与其让夜间模式、截图、高亮等模块各写一遍，不如在这里收敛。
// 少写一遍就少一次"忘了先查就 request，于是每次弹框"的机会。

/**
 * 一次注入操作的结果。
 * @typedef {{ok:true, result:any} | {ok:false, error:string}} InjectResult
 */

/**
 * 取 tab 主 frame 的 origin 模式（`https://example.com/*`）。
 *
 * 只接受 http/https：`chrome://`、`file://`、扩展页都不能注入，
 * 也不该让它们走到 `permissions.request`（那会弹一个必然被拒的框）。
 *
 * @param {object} webNavigation `chrome.webNavigation`
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
export async function originPatternOf(webNavigation, tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const frame = await webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame || typeof frame.url !== 'string') return null;
    const u = new URL(frame.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * 确保已持有该 origin 的宿主权限。
 *
 * **顺序很关键：先查再请求。**
 * `permissions.request` 每次都会弹一次确认框——用户已经授权过的站点
 * 不该反复弹。忘了先查的表现是"每点一次都要确认一次"，用户很快就烦了。
 *
 * 没有 `permissions` API 时返回 `true`：让 `executeScript` 自己报它该报的错，
 * 比在这里编一个错误码更诚实。
 *
 * @param {object|undefined} permissions `chrome.permissions`
 * @param {string} origin
 * @returns {Promise<boolean>}
 */
export async function ensureHostPermission(permissions, origin) {
  if (!permissions) return true;
  if (!origin) return false;
  try {
    if (await permissions.contains({ origins: [origin] })) return true;
    return Boolean(await permissions.request({ origins: [origin] }));
  } catch {
    // 请求本身就失败（策略禁止、缺用户手势等）——按未授权处理
    return false;
  }
}

/**
 * 把自包含函数注入指定 tab 的主 frame，并取出它的返回值。
 *
 * 三件事在这里一次做对：
 *   - 只注入主 frame（`frameIds: [0]`）：iframe 里的页面不该被同一个动作改两次
 *   - 取第一个结果（`executeScript` 按 frame 返回数组）
 *   - 把"结果为空"与"注入失败"分开表达
 *
 * @param {object} scripting `chrome.scripting`
 * @param {number} tabId
 * @param {Function} func 自包含函数
 * @param {any[]} [args]
 * @returns {Promise<InjectResult>}
 */
export async function runInFrame(scripting, tabId, func, args = []) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'BAD_TAB' };
  try {
    const results = await scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func,
      args,
    });
    const first = Array.isArray(results) ? results[0] : null;
    if (!first || first.result === undefined) return { ok: false, error: 'NO_RESULT' };
    return { ok: true, result: first.result };
  } catch (e) {
    // 只回稳定错误码，不回 e.message：后者含 Chrome 的长句与内部细节。
    // 但要把"没权限"和其它失败分开——上层据此决定提示"请重新授权"还是"操作失败"。
    const msg = String((e && e.message) || '');
    if (/permission|Cannot access contents/i.test(msg)) {
      return { ok: false, error: 'HOST_PERMISSION_DENIED' };
    }
    return { ok: false, error: 'INJECT_FAILED' };
  }
}

/**
 * 一次性完成"取 origin → 确保权限 → 注入"。
 *
 * 这是注入类模块最常用的组合，抽成一步以免每个模块重复四行样板。
 *
 * @param {{scripting:object, permissions?:object, webNavigation:object}} deps
 * @param {number} tabId
 * @param {Function} func
 * @param {any[]} [args]
 * @param {{needPermission?:boolean}} [opts]
 * @returns {Promise<InjectResult>}
 */
export async function injectInto(deps, tabId, func, args = [], opts = {}) {
  const needPermission = opts.needPermission !== false;

  let origin = null;
  if (needPermission) {
    origin = await originPatternOf(deps.webNavigation, tabId);
    if (!origin) return { ok: false, error: 'NO_ORIGIN' };
    const granted = await ensureHostPermission(deps.permissions, origin);
    if (!granted) return { ok: false, error: 'HOST_PERMISSION_DENIED' };
  }

  return runInFrame(deps.scripting, tabId, func, args);
}
