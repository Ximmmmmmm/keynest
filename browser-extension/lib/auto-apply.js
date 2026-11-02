// 自动应用：页面加载时，把「用户在这个站点开过」的模块重新打开。
//
// # 为什么这需要一层协议，而不是各模块自己听标签页事件
//
// 夜间模式、阅读模式都要这个能力。如果各写一套：
//
//   - 各自注册 `tabs.onUpdated` / `webNavigation.onCommitted`
//   - 各自判断"这个站点在不在我的名单里"
//   - 各自调 `executeScript`
//
// 三份重复的监听器会争着注入，页面加载时可能连吃三次 `executeScript`。
// 更要紧的是"没有用户手势"这件事会在三处分别被忘掉。
//
// 所以这里定义一份**模块只需实现一个方法**的协议：
//
//   ```js
//   module.autoApply = {
//     shouldApply(host, ctx) -> boolean     // 该不该在这个站点自动开
//     apply(tabId, ctx)     -> Promise     // 打开它（内部走 injectInto）
//   }
//   ```
//
// 宿主统一扫一遍已注册模块，挑出带 `autoApply` 且已启用的，逐个问。
//
// # 一条硬约束：绝不请求权限
//
// 页面加载时没有用户手势。此时 `permissions.request` 要么被静默拒绝，
// 要么弹一个用户根本没预期到的确认框——后者更糟，用户会以为浏览器出问题了。
//
// 所以 `applyAuto` 里所有注入都走 `requestPermission: false`：
// **已授权就注入，没授权就安静地什么都不做**。
//
// 用户想用这个功能，得先在 popup 里主动点一次（那一次有手势，能弹框）。

/**
 * 一次自动应用的结果（单模块）。
 * @typedef {{moduleId:string, applied:boolean, error?:string}} AutoResult
 */

/**
 * 在某个 tab 上跑一遍自动应用。
 *
 * 三层防御，每层都对应一种真实的坏情况：
 *
 *   1. **模块没实现 autoApply** → 跳过（不是所有模块都能自动应用）
 *   2. **模块被禁用** → 跳过（用户关掉的功能不该在加载时又冒出来）
 *   3. **单个模块抛错** → 记录并继续（一个模块坏了不能拖垮另一个）
 *
 * @param {object} deps
 * @param {import('./modules.js').ModuleRegistry} deps.registry
 * @param {{scripting:object, permissions?:object, webNavigation:object}} deps.injectDeps
 * @param {number} tabId
 * @param {string} host
 * @param {object} [opts]
 * @param {(moduleId:string) => any} [opts.configFor] 取模块配置视图
 * @returns {Promise<{ok:boolean, results:AutoResult[]}>}
 */
export async function applyAuto(deps, tabId, host, opts = {}) {
  if (!Number.isInteger(tabId)) return { ok: false, results: [] };
  if (typeof host !== 'string' || !host) return { ok: false, results: [] };

  const results = [];
  const configFor = opts.configFor || ((id) => deps.registry.configOf(id));

  // 按模块注册顺序遍历，结果顺序稳定（报告里可对照）
  for (const entry of deps.registry.entries()) {
    const mod = entry.raw;

    // 1) 没实现自动应用 → 跳过
    if (!mod || !mod.autoApply) continue;
    // 2) 模块被禁用 → 跳过。用户关掉的功能不该在页面加载时又冒出来。
    if (!deps.registry.isEnabled(entry.id)) continue;

    const ctx = { config: configFor(entry.id), moduleId: entry.id };

    try {
      // 3) 先问"该不该"，再执行。分开是为了让"不该"不产生任何副作用，
      //    也便于测试"判断正确但执行失败"这种情况。
      const should = await mod.autoApply.shouldApply(host, ctx);
      if (!should) continue;

      const out = await mod.autoApply.apply(tabId, ctx);
      results.push({
        moduleId: entry.id,
        applied: Boolean(out && out.ok),
        ...(out && out.error ? { error: out.error } : {}),
      });
    } catch (e) {
      // 一个模块抛错不能拖垮另一个。只记状态码，不回 e.message。
      results.push({
        moduleId: entry.id,
        applied: false,
        error: typeof e?.code === 'string' ? e.code : 'AUTO_APPLY_FAILED',
      });
    }
  }

  return { ok: true, results };
}

/**
 * 支持自动应用的模块 id 清单（诊断用）。
 * @param {import('./modules.js').ModuleRegistry} registry
 */
export function autoApplyModules(registry) {
  return registry
    .entries()
    .filter((e) => e.raw && e.raw.autoApply)
    .map((e) => e.id);
}
