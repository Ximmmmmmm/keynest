// 「模块管理」模块 —— 让模块注册表对设置页可见、可操作。
//
// # 为什么要把它做成一个模块而不是在宿主里开特例
//
// 如果设置页的接口散在宿主里，那"谁改了什么"就又回到不可审计的状态。
// 做成模块的好处：
//
//   - 它的权限声明（这里只需要 extensionPages）和其它模块一样被记账
//   - 设置页本身能出现在 `modules.list` 的返回里——用户能看到"连改设置的入口
//     也是一个模块"
//   - 将来要加"导出配置/导入配置"之类的功能，加在这个模块里即可
//
// # 它不返回什么
//
// 不返回任何配置的**值**以外的内容，不返回 handler 引用，不返回模块内部状态。
// 配置值本身也过一层白名单：只暴露 schema 里声明过的键（config.js 已保证
// 不存在 secret 键，因为带 secret 的 schema 根本注册不进去）。

/** 不可关闭的核心模块。与 host.js 的 CORE_MODULES 保持一致。 */
const CORE_MODULES = Object.freeze(['vault', 'registry']);

/**
 * @param {object} deps
 * @param {import('../modules.js').ModuleRegistry} deps.registry
 */
export function createModulesModule(deps) {
  return {
    id: 'registry',
    title: '模块管理',
    description: '查看与开关各功能模块，并核对每个模块申请的浏览器权限',
    defaultEnabled: true,
    // 纯扩展内页面操作，不碰任何网页，也不需要任何 manifest 权限
    requires: ['extensionPages'],
    handlers: [
      {
        type: 'modules.list',
        handle: () => ({
          ok: true,
          modules: deps.registry.list(),
          manifest: deps.registry.requiredManifestPermissions(),
        }),
      },
      {
        type: 'modules.set-enabled',
        handle: async (msg) => {
          const id = typeof msg.id === 'string' ? msg.id : '';
          if (!id) return { ok: false, error: 'BAD_ARGS' };
          if (typeof msg.enabled !== 'boolean') return { ok: false, error: 'BAD_ARGS' };
          // 核心模块不允许被关掉：关掉 vault 这个扩展就没有存在意义，
          // 关掉 registry 设置页会失去自我描述的能力。
          if (CORE_MODULES.includes(id)) return { ok: false, error: 'MODULE_REQUIRED' };
          await deps.registry.setEnabled(id, msg.enabled);
          return { ok: true, id, enabled: msg.enabled };
        },
      },
    ],
  };
}
