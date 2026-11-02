// 权限清单：把「某个模块需要什么浏览器能力」变成可审计的声明。
//
// # 为什么要在代码里再写一遍 manifest 权限
//
// manifest 里声明的是一组**静态**权限，浏览器在安装时一次性授予。
// 但本项目会有十几个功能模块，每个模块实际用到的能力差别很大：
// 密码填充要 `nativeMessaging`，广告过滤要 `declarativeNetRequest`，
// 截图要 `tabs.captureVisibleTab`。
//
// 如果在 manifest 里把所有权限一次性声明满，用户看到的是「这个扩展能读写所有网站数据」——
// 那等于放弃最小权限原则，也是浏览器商店审核最常拒绝的一类。
//
// 所以这里做两件事：
//
//   1. **声明**：每个模块用 `requires` 明确列出它要的能力，代码里用到清单外的能力
//      在开发期就会被 `assertCapability` 拦住。
//   2. **求和**：`requiredManifestPermissions()` 从**已启用模块**反推出 manifest
//      应该声明什么，让"加了模块但忘了加权限"和"加了权限但没模块用"都能被发现。
//
// # 这个文件不做什么
//
// - 不申请权限（那是 manifest 的事）
// - 不做运行时权限授予（`chrome.permissions.request` 需要用户手势，属于 UI 层）
// - 不信任模块自称：`requires` 只被记录与比对，不被当作授权

import { KeyNestError } from './errors.js';

/** 已知能力 → 对应的 manifest 权限名。值 `null` 表示「不需要 manifest 权限」。 */
export const CAPABILITIES = Object.freeze({
  // 与 KeyNest 桌面端通信
  nativeMessaging: 'nativeMessaging',
  // 读取当前标签页（用户在扩展 UI 上点击后）
  activeTab: 'activeTab',
  // 向页面注入脚本
  scripting: 'scripting',
  // 观察导航（documentId 来源）
  webNavigation: 'webNavigation',
  // 标签页枚举 / 关闭 / 分组
  tabs: 'tabs',
  // 内容脚本要跑的站点范围（以 host 权限形式声明）
  hostHttps: 'host:https',
  // 网络请求拦截（广告、跟踪器）
  declarativeNetRequest: 'declarativeNetRequest',
  // 读取/修改页面内容（阅读模式、夜间模式、划词）
  contentScript: null,
  // 在扩展页面里渲染（popup / options / 独立页）
  extensionPages: null,
  // 本地通知
  notifications: 'notifications',
  // 右键菜单
  contextMenus: 'contextMenus',
  // 扩展级存储（**敏感数据禁止**：见 config.js 的 SECRET_FORBIDDEN）
  storage: 'storage',
  // 剪贴板写入（仅扩展页面）
  clipboardWrite: 'clipboardWrite',
});

const CAPABILITY_NAMES = new Set(Object.keys(CAPABILITIES));

export class PermissionError extends KeyNestError {
  constructor(code, message) {
    super(code, message);
  }
}

/**
 * 校验一个模块声明的能力清单。
 *
 * 刻意**不允许**模块自行声明全站通配的 host 范围：
 * 全站访问必须由 manifest 统一声明并经用户确认，不能由模块自行扩大。
 *
 * @param {string[]} requires
 * @returns {ReadonlyArray<string>}
 */
export function validateRequires(moduleId, requires) {
  if (!Array.isArray(requires)) {
    throw new PermissionError('BAD_REQUIRES', `${moduleId}: requires 必须是数组`);
  }
  const out = [];
  for (const cap of requires) {
    if (typeof cap !== 'string' || !CAPABILITY_NAMES.has(cap)) {
      throw new PermissionError('UNKNOWN_CAPABILITY', `${moduleId}: 未知能力 ${cap}`);
    }
    if (out.includes(cap)) {
      throw new PermissionError('DUPLICATE_CAPABILITY', `${moduleId}: 能力重复声明 ${cap}`);
    }
    out.push(cap);
  }
  return Object.freeze(out);
}

/**
 * 运行时断言：当前上下文确实持有某个能力。
 *
 * 这不是安全边界（真正的边界是浏览器给的权限），而是**开发期护栏**——
 * 让「模块用了它没声明的能力」在第一次跑测试时就炸，而不是等用户报错。
 *
 * @param {string} moduleId
 * @param {string} capability
 * @param {ReadonlyArray<string>} declared 该模块声明的能力
 */
export function assertCapability(moduleId, capability, declared) {
  if (!CAPABILITY_NAMES.has(capability)) {
    throw new PermissionError('UNKNOWN_CAPABILITY', `${moduleId}: 未知能力 ${capability}`);
  }
  if (!declared.includes(capability)) {
    throw new PermissionError(
      'UNDECLARED_CAPABILITY',
      `${moduleId}: 使用了未声明的能力 ${capability}（在模块的 requires 里补上）`
    );
  }
}

/**
 * 从模块清单求和出 manifest 需要的权限。
 *
 * @param {Array<{id:string, requires:ReadonlyArray<string>, enabledByDefault?:boolean}>} modules
 * @returns {{permissions: string[], hostPermissions: string[], unknownCapabilities: string[]}}
 */
export function requiredManifestPermissions(modules) {
  const permissions = new Set();
  const hostPermissions = new Set();
  const unknown = new Set();

  for (const m of modules) {
    for (const cap of m.requires || []) {
      if (!CAPABILITY_NAMES.has(cap)) {
        unknown.add(cap);
        continue;
      }
      const mapped = CAPABILITIES[cap];
      if (mapped === null) continue;
      if (mapped === 'host:https') {
        hostPermissions.add('https://*/*');
      } else {
        permissions.add(mapped);
      }
    }
  }

  // 排序让输出稳定，报告与 diff 才可比
  return {
    permissions: [...permissions].sort(),
    hostPermissions: [...hostPermissions].sort(),
    unknownCapabilities: [...unknown].sort(),
  };
}

/**
 * 比对「manifest 实际声明的」与「模块实际需要的」。
 *
 * 两个方向都要报：
 *   - `missing` —— 模块需要但 manifest 没声明 → 运行时必然失败
 *   - `unused`  —— manifest 声明了但没有模块用 → 权限膨胀，应删掉
 *
 * @param {{permissions?:string[], host_permissions?:string[]}} manifest
 * @param {Array<{id:string, requires:ReadonlyArray<string>}>} modules
 */
export function diffManifest(manifest, modules) {
  const need = requiredManifestPermissions(modules);
  const have = new Set(manifest.permissions || []);
  const haveHosts = new Set(manifest.host_permissions || []);

  const missing = need.permissions.filter((p) => !have.has(p));
  const unused = [...have].filter((p) => !need.permissions.includes(p)).sort();
  const missingHosts = need.hostPermissions.filter((h) => !haveHosts.has(h));

  return {
    missing,
    unused,
    missingHosts,
    // host 权限不做 unused 检查：它常被 content_scripts.matches 复用，
    // 只声明在 manifest 顶层而没写进 host_permissions 也是合法的。
    unknownCapabilities: need.unknownCapabilities,
    ok: missing.length === 0 && unused.length === 0 && missingHosts.length === 0,
  };
}
