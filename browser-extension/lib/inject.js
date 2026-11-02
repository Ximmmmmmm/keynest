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
 * 只查是否已持有权限，**不请求**。
 *
 * 用于页面加载时的自动应用：那时没有用户手势，
 * `permissions.request` 要么被静默拒绝，要么弹一个用户没预期到的框。
 *
 * 没有 `permissions` API 时返回 `true`（与 `ensureHostPermission` 一致），
 * 让 `executeScript` 自己报它该报的错。
 *
 * @param {object|undefined} permissions
 * @param {string} origin
 * @returns {Promise<boolean>}
 */
export async function hasHostPermission(permissions, origin) {
  if (!permissions) return true;
  if (!origin) return false;
  try {
    return Boolean(await permissions.contains({ origins: [origin] }));
  } catch {
    return false;
  }
}

/**
 * 把自包含函数注入指定 tab 的主 frame，并取出它的返回值。
 *
 * 三件事在这里一次做对：
 *   - 只注入主 frame（`frameIds: [0]`）：iframe 里的页面不该被同一个动作改两次
 *   - 取第一个结果（`executeScript` 按 frame 返回数组）
 *   - 把三层失败分开表达：注入本身失败 / 结果为空 / **注入函数自己返回了失败**
 *
 * 第三层最容易被漏：注入成功、函数跑完、返回 `{ok:false, error:'NO_CONTENT'}`——
 * 从 `executeScript` 的角度这是**完全成功**的调用。不检查这个字段的话，
 * 上层会把失败当成功，于是"注入失败却记成已开启"，用户看到开关自己跳。
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

    const result = first.result;
    // 注入函数自己报告失败（例如"提不出正文"）：这是**业务失败**，
    // 与"注入技术失败"必须区分——上层对两者的处理完全不同。
    if (result && typeof result === 'object' && result.ok === false) {
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'INJECTED_FAILED' };
    }

    return { ok: true, result };
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
 * # `requestPermission: false` —— 自动应用必须用这个模式
 *
 * 页面加载时**没有用户手势**。此时调 `permissions.request` 的结果是：
 * 要么被静默拒绝，要么弹一个用户根本没预期到的确认框。后者更糟。
 *
 * 所以自动应用的路径只**查**不请：已授权就注入，没授权就安静地什么都不做。
 * 用户想用这个功能，得先在 popup 里主动点一次（那一次有手势，能弹框）。
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
  // 默认允许请求——用户主动触发的路径（点按钮）应该有这个能力。
  // 自动应用必须传 false：页面加载时没有用户手势，
  // 请求要么被静默拒绝，要么弹一个用户根本没预期到的确认框。
  const requestPermission = opts.requestPermission !== false;

  if (needPermission) {
    const origin = await originPatternOf(deps.webNavigation, tabId);
    if (!origin) return { ok: false, error: 'NO_ORIGIN' };

    const granted = requestPermission
      ? await ensureHostPermission(deps.permissions, origin)
      : await hasHostPermission(deps.permissions, origin);
    if (!granted) return { ok: false, error: 'HOST_PERMISSION_DENIED' };
  }

  return runInFrame(deps.scripting, tabId, func, args);
}
