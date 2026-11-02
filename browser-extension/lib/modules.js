// 模块注册表：每个功能是一个模块，声明自己的 id、能力、配置 schema 和消息处理器。
//
// # 立这个结构要解决的问题
//
// 现在的 service-worker.js 是一个单体：消息路由、授权状态机、Native 端口
// 全在一个文件里。要再加十几个功能（广告过滤、阅读模式、截图、笔记……）
// 有两条路：
//
//   A. 继续往这个文件里加 → 半年后没人敢改，权限也说不清谁用了什么
//   B. 先立骨架，每个功能自成模块 → 加功能时只需写一个文件 + 注册一行
//
// 这里选 B。骨架必须足够薄，薄到不拖慢现在的密码填充流程：
// 注册表本身不发起任何浏览器 API 调用，只做**登记、校验、分派**。
//
// # 诚实的边界
//
// 模块系统**不是**安全边界。真正的边界是：
//   - 浏览器权限（manifest + 运行时授权）
//   - 密码填充那条一次性 nonce 链路（lib/redeem.js）
//
// 模块系统解决的是**可维护性与可审计性**：谁要什么权限、谁处理哪类消息、
// 某个功能坏了会不会拖垮别的功能。

import { ConfigCenter } from './config.js';
import { KeyNestError } from './errors.js';
import { validateRequires, requiredManifestPermissions, PermissionError } from './permissions.js';

/** 模块 id 与 config.js 保持同一形状。 */
const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * 消息类型的形状：`name` 或 `namespace.action`。
 *
 * 允许不带点，是因为**现有已发布的密码填充链路用的是 `status` / `query` /
 * `authorize-fill` 这套名字**。它们已经在真实 Chrome 里验证过、content script
 * 里也是硬编码的字符串——为了"结构好看"去改线上协议，只有风险没有收益。
 * 新模块用 `namespace.action`，旧名字原样保留。
 */
const MESSAGE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export class ModuleError extends KeyNestError {
  constructor(code, message) {
    super(code, message);
  }
}

/**
 * @typedef {object} ModuleSpec
 * @property {string} id
 * @property {string} title        给用户看的名字（中文）
 * @property {string} [description]
 * @property {ReadonlyArray<string>} requires   见 lib/permissions.js
 * @property {boolean} [defaultEnabled]
 * @property {Record<string, object>} [config]  配置 schema，见 lib/config.js
 * @property {Array<{type:string, handle:(msg:object, ctx:object)=>Promise<object>|object}>} [handlers]
 */

/**
 * 校验一个模块定义。**在注册时就校验完**，不留到运行时。
 * @param {ModuleSpec} spec
 */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new ModuleError('BAD_SPEC', '模块定义必须是对象');
  }
  if (typeof spec.id !== 'string' || !MODULE_ID_RE.test(spec.id)) {
    throw new ModuleError('BAD_ID', `非法的模块 id: ${spec.id}`);
  }
  if (typeof spec.title !== 'string' || !spec.title) {
    throw new ModuleError('BAD_TITLE', `${spec.id}: 缺少 title`);
  }
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    throw new ModuleError('BAD_DESCRIPTION', `${spec.id}: description 必须是字符串`);
  }
  const requires = validateRequires(spec.id, spec.requires || []);
  if (spec.defaultEnabled !== undefined && typeof spec.defaultEnabled !== 'boolean') {
    throw new ModuleError('BAD_DEFAULT', `${spec.id}: defaultEnabled 必须是布尔`);
  }
  const defaultEnabled = spec.defaultEnabled !== false; // 未声明即默认启用

  const handlers = spec.handlers || [];
  if (!Array.isArray(handlers)) {
    throw new ModuleError('BAD_HANDLERS', `${spec.id}: handlers 必须是数组`);
  }
  const seen = new Set();
  for (const h of handlers) {
    if (!h || typeof h !== 'object') {
      throw new ModuleError('BAD_HANDLER', `${spec.id}: handler 必须是对象`);
    }
    if (typeof h.type !== 'string' || !MESSAGE_RE.test(h.type)) {
      throw new ModuleError('BAD_MESSAGE_TYPE', `${spec.id}: 非法消息类型 ${h.type}`);
    }
    if (typeof h.handle !== 'function') {
      throw new ModuleError('BAD_HANDLER', `${spec.id}: ${h.type} 缺少 handle 函数`);
    }
    if (seen.has(h.type)) {
      throw new ModuleError('DUPLICATE_HANDLER', `${spec.id}: 消息类型重复 ${h.type}`);
    }
    seen.add(h.type);
  }

  return {
    id: spec.id,
    title: spec.title,
    description: spec.description || '',
    requires,
    defaultEnabled,
    config: spec.config || {},
    handlers: handlers.map((h) => ({ type: h.type, handle: h.handle })),
    // 保留原始对象，方便模块自己挂额外字段
    raw: spec,
  };
}

export class ModuleRegistry {
  /**
   * @param {{config?: ConfigCenter}} [opts]
   */
  constructor(opts = {}) {
    this.config = opts.config || new ConfigCenter();
    /** @type {Map<string, ReturnType<typeof validateSpec> & {configView: import('./config.js').ModuleConfig}>} */
    this.modules = new Map();
    /** @type {Map<string, string>} 消息类型 → 模块 id */
    this.messageIndex = new Map();
  }

  /**
   * 注册模块。id 与消息类型都唯一；冲突直接抛，不覆盖。
   * @param {ModuleSpec} spec
   */
  register(spec) {
    const m = validateSpec(spec);
    if (this.modules.has(m.id)) {
      throw new ModuleError('DUPLICATE_MODULE', `模块重复注册: ${m.id}`);
    }
    // 先查消息冲突再落盘，避免注册到一半失败留下半截状态
    for (const h of m.handlers) {
      const owner = this.messageIndex.get(h.type);
      if (owner) {
        throw new ModuleError(
          'DUPLICATE_MESSAGE',
          `消息类型 ${h.type} 已被模块 ${owner} 占用`
        );
      }
    }

    // 每个模块都自动获得 `enabled`：不让模块自己写，避免 20 个模块写 20 遍、
    // 有人写错类型、有人漏掉默认值。模块若显式声明了 enabled，以模块的为准
    // （但仍必须是 boolean）。
    const configSpec = { enabled: { type: 'boolean', default: m.defaultEnabled }, ...m.config };
    const configView = this.config.registerModule(m.id, configSpec);
    const entry = { ...m, configView };
    this.modules.set(m.id, entry);
    for (const h of m.handlers) this.messageIndex.set(h.type, m.id);
    return entry;
  }

  /** 是否启用（按配置中心的值；未载入时用 defaultEnabled）。 */
  isEnabled(moduleId) {
    const m = this.modules.get(moduleId);
    if (!m) throw new ModuleError('UNKNOWN_MODULE', `未注册的模块: ${moduleId}`);
    return m.configView.get('enabled');
  }

  async setEnabled(moduleId, enabled) {
    const m = this.modules.get(moduleId);
    if (!m) throw new ModuleError('UNKNOWN_MODULE', `未注册的模块: ${moduleId}`);
    await m.configView.set('enabled', enabled);
  }

  /** 所有模块的公开描述（给设置页用；不含 handler）。 */
  list() {
    return [...this.modules.values()].map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      requires: [...m.requires],
      enabled: this.isEnabled(m.id),
      config: m.configView.all(),
    }));
  }

  /**
   * 分派一条消息。
   *
   * 三件事必须做对，每一件都对应一类真实故障：
   *
   *   1. **未知类型** → 明确返回 `UNKNOWN_TYPE`，不静默吞掉（否则前端只会超时）
   *   2. **模块已禁用** → 返回 `MODULE_DISABLED`，不执行 handler
   *   3. **handler 抛错** → 捕获并返回 `HANDLER_FAILED` + 错误码，
   *      绝不让一个模块的异常冒到 SW 顶层把整个消息循环搞挂
   *
   * 返回值就是**直接回给发送方的那份响应**，不做二次包装（理由见实现里的注释）。
   *
   * @param {string} type
   * @param {object} msg
   * @param {object} ctx
   * @returns {Promise<object>}
   */
  async dispatch(type, msg, ctx) {
    const moduleId = this.messageIndex.get(type);
    if (!moduleId) {
      return { ok: false, error: 'UNKNOWN_TYPE' };
    }
    const m = this.modules.get(moduleId);
    if (!this.isEnabled(moduleId)) {
      return { ok: false, error: 'MODULE_DISABLED' };
    }
    const handler = m.handlers.find((h) => h.type === type);
    if (!handler) {
      // 理论上不会发生（messageIndex 建立时已确认），留一条防御分支
      return { ok: false, error: 'NO_HANDLER' };
    }
    try {
      // handler 返回的就是**完整响应体**，不再包一层 {ok:true,data}。
      //
      // 为什么不统一包装：现有线上协议是
      //   status          → { ok:true, data:{locked,protocol,version} }
      //   query           → { ok:true, origin, entries }
      //   authorize-fill  → { ok:true, nonce }
      // 三种形状不同，是 content script 与 popup 里硬编码的。
      // 为了"结构整齐"去改线上协议，只有风险没有收益。
      return await handler.handle(msg, { ...ctx, moduleId, config: m.configView });
    } catch (e) {
      // 只回错误码，不回 e.message：后者可能带路径、条目名之类不该过桥的东西
      const code = typeof e?.code === 'string' ? e.code : 'HANDLER_FAILED';
      return { ok: false, error: code };
    }
  }

  /** 由已注册模块反推 manifest 需要的权限。 */
  requiredManifestPermissions() {
    return requiredManifestPermissions([...this.modules.values()]);
  }

  /** 检查某个能力是否被任一模块声明 —— 用于开发期的「权限是否有人用」审计。 */
  capabilityOwners(capability) {
    const owners = [];
    for (const m of this.modules.values()) {
      if (m.requires.includes(capability)) owners.push(m.id);
    }
    return owners;
  }
}

export { PermissionError };
