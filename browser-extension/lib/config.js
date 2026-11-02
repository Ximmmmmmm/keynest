// 配置中心：所有模块设置的**唯一**入口。
//
// # 为什么需要一个中心，而不是各模块自己存
//
// 三个理由，每个都对应一类真实故障：
//
//   1. **校验**。没有 schema 的配置就是一堆 `undefined`：模块读到 `undefined`
//      当成 `false`，于是「用户明明开了却像没开」。这里每个键都必须先声明类型、
//      默认值、取值范围，读写都过一遍校验。
//
//   2. **命名空间**。模块 A 写 `enabled`、模块 B 也写 `enabled`，共存时互相踩。
//      这里按模块 id 分命名空间，键只在模块内可见。
//
//   3. **绝不存密钥**。schema 里出现 `secret: true` 直接**注册失败**——
//      不是"提醒你别这么写"，而是根本注册不进去。密码、token、主密码
//      永远不会因为某个模块图省事而被写进浏览器存储。
//
// # 存储后端
//
// 本阶段默认**内存后端**，不引入 `storage` 权限。
//
// 这是刻意的取舍：扩展当前连 `chrome.storage` 都没有（manifest 里没声明），
// 这正是它「不持久化任何敏感状态」的一部分。要持久化设置就得加权限，
// 那是一次需要单独审查的安全决策，不该被"顺手"塞进架构重构里。
//
// 需要持久化时，给 `ConfigCenter` 传一个实现 `{ read, write, delete }` 的后端即可，
// 中心本身不关心后端是什么。

import { KeyNestError } from './errors.js';

/** 模块 id 的形状：小写字母开头，只允许小写字母、数字、连字符。 */
const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/;

/** 配置键的形状。不允许点号：点号留给未来做层级，现在禁掉避免语义漂移。 */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const TYPES = new Set(['boolean', 'number', 'string', 'enum']);

export class ConfigError extends KeyNestError {
  /**
   * @param {'BAD_MODULE_ID'|'BAD_KEY'|'BAD_SCHEMA'|'SECRET_FORBIDDEN'|'UNKNOWN_MODULE'|'UNKNOWN_KEY'|'BAD_TYPE'|'OUT_OF_RANGE'|'BAD_VALUE'|'DUPLICATE_MODULE'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(code, message);
  }
}

/**
 * 校验并冻结一份 schema。
 *
 * 冻结是为了让「注册后偷偷改 schema」不可能：模块拿到的是同一个对象，
 * 改它会在严格模式下抛错，而不是悄悄让校验失效。
 *
 * @param {Record<string, object>} spec
 * @returns {Readonly<Record<string, object>>}
 */
export function defineSchema(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ConfigError('BAD_SCHEMA', 'schema 必须是对象');
  }
  const out = Object.create(null);
  for (const [key, raw] of Object.entries(spec)) {
    if (!KEY_RE.test(key)) {
      throw new ConfigError('BAD_KEY', `非法的配置键名: ${key}`);
    }
    if (!raw || typeof raw !== 'object') {
      throw new ConfigError('BAD_SCHEMA', `${key}: 定义必须是对象`);
    }
    if (raw.secret === true) {
      // 这就是那条硬规则。不给"以后再说"的余地。
      throw new ConfigError(
        'SECRET_FORBIDDEN',
        `${key}: 配置中心不接受 secret 字段——密码/密钥/令牌一律不得写入配置`
      );
    }
    if (!TYPES.has(raw.type)) {
      throw new ConfigError('BAD_SCHEMA', `${key}: 未知类型 ${raw.type}`);
    }

    const entry = { type: raw.type, default: raw.default };

    if (raw.type === 'boolean') {
      if (typeof raw.default !== 'boolean') {
        throw new ConfigError('BAD_SCHEMA', `${key}: boolean 的默认值必须是布尔`);
      }
    } else if (raw.type === 'number') {
      if (typeof raw.default !== 'number' || !Number.isFinite(raw.default)) {
        throw new ConfigError('BAD_SCHEMA', `${key}: number 的默认值必须是有限数`);
      }
      const min = raw.min ?? Number.NEGATIVE_INFINITY;
      const max = raw.max ?? Number.POSITIVE_INFINITY;
      if (!(min <= max)) {
        throw new ConfigError('BAD_SCHEMA', `${key}: min 大于 max`);
      }
      if (raw.default < min || raw.default > max) {
        throw new ConfigError('BAD_SCHEMA', `${key}: 默认值超出 [min, max]`);
      }
      entry.min = min;
      entry.max = max;
      // 整数约束单独标出来：像素值、秒数这类用浮点没有意义，且会带来 1.0000001 之类的坑
      entry.integer = raw.integer === true;
      if (entry.integer && !Number.isInteger(raw.default)) {
        throw new ConfigError('BAD_SCHEMA', `${key}: 声明了 integer 但默认值不是整数`);
      }
    } else if (raw.type === 'string') {
      if (typeof raw.default !== 'string') {
        throw new ConfigError('BAD_SCHEMA', `${key}: string 的默认值必须是字符串`);
      }
      const maxLength = raw.maxLength ?? 512;
      if (!Number.isInteger(maxLength) || maxLength <= 0) {
        throw new ConfigError('BAD_SCHEMA', `${key}: maxLength 必须是正整数`);
      }
      if (raw.default.length > maxLength) {
        throw new ConfigError('BAD_SCHEMA', `${key}: 默认值超过 maxLength`);
      }
      entry.maxLength = maxLength;
    } else if (raw.type === 'enum') {
      if (!Array.isArray(raw.values) || raw.values.length === 0) {
        throw new ConfigError('BAD_SCHEMA', `${key}: enum 必须给出非空 values`);
      }
      if (!raw.values.includes(raw.default)) {
        throw new ConfigError('BAD_SCHEMA', `${key}: 默认值不在 values 里`);
      }
      entry.values = Object.freeze([...raw.values]);
    }

    out[key] = Object.freeze(entry);
  }
  return Object.freeze(out);
}

/** 按 schema 校验一个值，返回规范化后的值；不合法则抛 ConfigError。 */
export function validateValue(schema, key, value) {
  const s = schema[key];
  if (s.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new ConfigError('BAD_TYPE', `${key}: 需要布尔值`);
    }
    return value;
  }
  if (s.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ConfigError('BAD_TYPE', `${key}: 需要有限数`);
    }
    if (s.integer && !Number.isInteger(value)) {
      throw new ConfigError('BAD_TYPE', `${key}: 需要整数`);
    }
    if (value < s.min || value > s.max) {
      throw new ConfigError('OUT_OF_RANGE', `${key}: 超出允许范围`);
    }
    return value;
  }
  if (s.type === 'string') {
    if (typeof value !== 'string') {
      throw new ConfigError('BAD_TYPE', `${key}: 需要字符串`);
    }
    if (value.length > s.maxLength) {
      throw new ConfigError('OUT_OF_RANGE', `${key}: 超过最大长度`);
    }
    return value;
  }
  // enum
  if (!s.values.includes(value)) {
    throw new ConfigError('BAD_VALUE', `${key}: 不是允许的取值`);
  }
  return value;
}

/**
 * 内存后端。进程/上下文结束即丢——对 SW 来说等于「重启回到默认值」。
 *
 * 这正是当前阶段想要的：不持久化任何东西。
 */
export class MemoryStore {
  constructor(initial) {
    /** @type {Map<string, Record<string, unknown>>} */
    this.map = new Map(Object.entries(initial || {}));
  }

  async read(ns) {
    const v = this.map.get(ns);
    // 返回浅拷贝：调用方拿到的是快照，改它不会影响后端
    return v ? { ...v } : null;
  }

  async write(ns, value) {
    this.map.set(ns, { ...value });
  }

  async delete(ns) {
    this.map.delete(ns);
  }
}

/** 模块的配置视图。只暴露该模块自己命名空间下的键。 */
export class ModuleConfig {
  constructor(center, moduleId) {
    this.center = center;
    this.moduleId = moduleId;
  }

  get(key) {
    return this.center.get(this.moduleId, key);
  }

  all() {
    return this.center.all(this.moduleId);
  }

  async set(key, value) {
    return this.center.set(this.moduleId, key, value);
  }

  async reset() {
    return this.center.reset(this.moduleId);
  }
}

export class ConfigCenter {
  /** 已载入/写入的模块 → 当前值 */
  #cache = new Map();

  /**
   * @param {{store?: {read(ns:string):Promise<object|null>, write(ns:string, v:object):Promise<void>, delete(ns:string):Promise<void>}}} [opts]
   */
  constructor(opts = {}) {
    this.store = opts.store || new MemoryStore();
    /** @type {Map<string, Readonly<Record<string, object>>>} */
    this.schemas = new Map();
  }

  /**
   * 注册模块的 schema。必须在使用该模块配置之前调用。
   * @param {string} moduleId
   * @param {Record<string, object>} [spec]
   * @returns {ModuleConfig}
   */
  registerModule(moduleId, spec) {
    if (!MODULE_ID_RE.test(moduleId)) {
      throw new ConfigError('BAD_MODULE_ID', `非法的模块 id: ${moduleId}`);
    }
    if (this.schemas.has(moduleId)) {
      throw new ConfigError('DUPLICATE_MODULE', `模块配置重复注册: ${moduleId}`);
    }
    this.schemas.set(moduleId, spec ? defineSchema(spec) : defineSchema({}));
    return new ModuleConfig(this, moduleId);
  }

  #schema(moduleId) {
    const s = this.schemas.get(moduleId);
    if (!s) {
      throw new ConfigError('UNKNOWN_MODULE', `未注册的模块: ${moduleId}`);
    }
    return s;
  }

  /**
   * 后端里的键名。
   *
   * **不带 `keynest.` 前缀**：前缀是存储后端的事（storage.js 的 STORAGE_PREFIX）。
   * 这里再带一次会变成 `keynest.keynest.cfg.x`——写入正常、读回全空，
   * 表现是"设置存了但重启就丢"，而且两边都不报错。
   *
   * 这个 bug 在阶段 3.0 接上真存储时被 storage.test.js 抓到。
   */
  #ns(moduleId) {
    return `cfg.${moduleId}`;
  }

  /** 读一个键的当前值（未设置则返回默认值）。 */
  get(moduleId, key) {
    const schema = this.#schema(moduleId);
    const s = schema[key];
    if (!s) throw new ConfigError('UNKNOWN_KEY', `${moduleId}: ${key} 未在 schema 中声明`);
    const stored = this.#cache.get(moduleId);
    if (stored && key in stored) return stored[key];
    return s.default;
  }

  /** 读整个模块的配置快照。 */
  all(moduleId) {
    const schema = this.#schema(moduleId);
    const stored = this.#cache.get(moduleId) || {};
    const out = Object.create(null);
    for (const [key, s] of Object.entries(schema)) {
      out[key] = key in stored ? stored[key] : s.default;
    }
    return out;
  }

  /**
   * 写一个键。非法值**不会**被写入（不会留下半截状态）。
   * @returns {Promise<void>}
   */
  async set(moduleId, key, value) {
    const schema = this.#schema(moduleId);
    if (!schema[key]) throw new ConfigError('UNKNOWN_KEY', `${moduleId}: ${key} 未在 schema 中声明`);
    const normalized = validateValue(schema, key, value);
    const next = { ...(this.#cache.get(moduleId) || {}), [key]: normalized };
    this.#cache.set(moduleId, next);
    await this.store.write(this.#ns(moduleId), next);
  }

  /** 重置回默认值。 */
  async reset(moduleId) {
    this.#schema(moduleId);
    this.#cache.delete(moduleId);
    await this.store.delete(this.#ns(moduleId));
  }

  /** 从后端载入。后端里不合法的键会被**丢弃**（回到默认），不会让整个模块起不来。 */
  async load(moduleId) {
    const schema = this.#schema(moduleId);
    const raw = await this.store.read(this.#ns(moduleId));
    if (!raw) {
      this.#cache.delete(moduleId);
      return { dropped: [] };
    }
    const clean = {};
    const dropped = [];
    for (const [key, value] of Object.entries(raw)) {
      if (!schema[key]) {
        dropped.push(key);
        continue;
      }
      try {
        clean[key] = validateValue(schema, key, value);
      } catch {
        dropped.push(key);
      }
    }
    this.#cache.set(moduleId, clean);
    return { dropped };
  }

  /** 已载入/写入过的模块 → 当前值。仅供诊断与测试。 */
  snapshot() {
    const out = Object.create(null);
    for (const moduleId of this.schemas.keys()) {
      out[moduleId] = this.all(moduleId);
    }
    return out;
  }

}
