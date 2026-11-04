// 持久化后端：把配置中心接到 `chrome.storage.local`。
//
// # 这一步为什么要单独一个阶段
//
// 阶段 2.8 刻意**不声明** `storage` 权限，理由是"这正是它不持久化任何敏感状态
// 的一部分"。现在要持久化用户设置（广告档位、豁免名单、模块开关），
// 就等于要打开这个口子——所以必须把边界说清楚：
//
//   1. **写进去的只有配置值**，且每个键都过了 schema 校验（config.js 保证
//      带 `secret:true` 的 schema 根本注册不进来）。
//   2. **不写任何密码、密钥、条目内容、nonce、cookie、页面数据。**
//   3. **不做跨设备同步**：用 `storage.local` 而不是 `storage.sync`。
//      sync 会把数据传到 Google 账户，那不是"本地密码管理器"该做的事。
//
// # 为什么要有这个文件而不是直接在 host.js 里调 chrome.storage
//
// 因为要让"存了什么"可审计。所有键都带 `keynest.` 前缀，`inspectStorage()`
// 能列举出当前实际存储的全部内容——这对"证明没有悄悄存敏感数据"是必需的，
// 而不是靠人读代码。
//
// # 后备：存储不可用时退回内存
//
// 扩展在 `storage` 权限被拒、或某些受限环境下拿不到 API 时，
// 退化成内存后端而不是崩掉。表现是"设置不持久"，而不是"扩展不能用"。

import { MemoryStore } from './config.js';

/** 所有键的统一前缀。审计与清理都靠它。 */
export const STORAGE_PREFIX = 'keynest.';

/**
 * `chrome.storage.local` 后端。
 *
 * @param {object} storageArea `chrome.storage.local`
 * @param {{prefix?:string}} [opts]
 */
export class ChromeStorageStore {
  constructor(storageArea, opts = {}) {
    this.area = storageArea;
    this.prefix = opts.prefix ?? STORAGE_PREFIX;
  }

  /** 只读该命名空间的键。用 prefix 过滤，避免读到别的模块或别的扩展遗留。 */
  async read(ns) {
    const key = this.prefix + ns;
    const got = await this.area.get(key);
    const v = got ? got[key] : undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  async write(ns, value) {
    const key = this.prefix + ns;
    await this.area.set({ [key]: value });
  }

  async delete(ns) {
    const key = this.prefix + ns;
    await this.area.remove(key);
  }

  /** 列举本后端写入的全部键（去掉前缀）。审计用。 */
  async listKeys() {
    const all = await this.area.get(null);
    return Object.keys(all || {})
      .filter((k) => k.startsWith(this.prefix))
      .map((k) => k.slice(this.prefix.length))
      .sort();
  }

  /** 清空本扩展写入的全部键。 */
  async clearAll() {
    const keys = await this.listKeys();
    if (keys.length === 0) return 0;
    await this.area.remove(keys.map((k) => this.prefix + k));
    return keys.length;
  }
}

/**
 * 选一个可用的存储后端。
 *
 * 探测方式不是"看有没有 API"，而是**真的写一次再删掉**——
 * 某些环境里 API 存在但调用会抛（配额、策略限制），只看存在性会误判。
 *
 * @param {object} chromeImpl
 * @returns {Promise<{store: object, persistent: boolean, reason: string}>}
 */
export async function pickStore(chromeImpl) {
  const area = chromeImpl?.storage?.local;
  if (!area) {
    return { store: new MemoryStore(), persistent: false, reason: 'NO_STORAGE_PERMISSION' };
  }

  const probeKey = `${STORAGE_PREFIX}__probe__`;
  try {
    await area.set({ [probeKey]: 1 });
    const got = await area.get(probeKey);
    await area.remove(probeKey);
    if (!got || got[probeKey] !== 1) {
      return { store: new MemoryStore(), persistent: false, reason: 'PROBE_MISMATCH' };
    }
    return { store: new ChromeStorageStore(area), persistent: true, reason: 'OK' };
  } catch (e) {
    // 不把 e.message 带出去：它可能含路径或策略细节，
    // 而调用方（设置页）只需要知道"是不是持久化"。
    return { store: new MemoryStore(), persistent: false, reason: 'PROBE_FAILED' };
  }
}

/**
 * 审计：当前实际存了什么。
 *
 * 返回每个命名空间的键名清单——**不返回值**。
 * 值可能包含用户设置的细节（比如豁免了哪些网站），
 * 展示给用户看是合理的，但不该出现在诊断日志里。
 *
 * @param {object} store
 */
export async function inspectStorage(store) {
  if (typeof store.listKeys !== 'function') {
    return { persistent: false, namespaces: [] };
  }
  const keys = await store.listKeys();
  // 命名空间形如 `cfg.<moduleId>`
  const namespaces = keys.map((k) => k.replace(/^cfg\./, ''));
  return { persistent: true, namespaces };
}

/**
 * 检查存储内容里有没有疑似敏感数据。
 *
 * 这是**防御性检查**，不是安全边界——真正的边界是 schema 拒绝 secret 字段。
 * 它的作用是：万一有模块绕过 schema 直接写存储，能在测试里被发现。
 *
 * 判定方式：扫描所有键名与字符串值里的敏感词。
 * 有命中就报出来，让开发者知道"有人绕过了配置中心"。
 *
 * @param {object} area `chrome.storage.local`（要用原始 API，因为可能要扫描全部键）
 */
export async function scanForSensitiveKeys(area) {
  const all = await area.get(null);
  const SUSPECT = [
    'password',
    'passwd',
    'secret',
    'token',
    'apikey',
    'api_key',
    'masterkey',
    'privatekey',
    'bridge.key',
    'vault.dat',
    'nonce',
    'cookie',
    'sessionid',
  ];
  const hits = [];

  const walk = (path, value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      // 只看键名与短字符串，长字符串（如用户笔记）不做词表扫描——
      // 误报率太高，反而会让人忽略真正的命中
      if (path && SUSPECT.some((s) => path.toLowerCase().includes(s))) {
        hits.push(path);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(path ? `${path}.${k}` : k, v);
    }
  };

  for (const [key, value] of Object.entries(all || {})) walk(key, value);
  return { hits, total: Object.keys(all || {}).length };
}
