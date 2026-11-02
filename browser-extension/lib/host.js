// 模块宿主：把真实 `chrome.*` 实现注入各模块，并对外提供统一的消息入口。
//
// # 分层
//
// ```text
// service-worker.js   ← 只有 40 行：建立宿主 + 注册 onMessage
//      ↓
// host.js             ← 这里：注入 chrome.*、持有注册表、分派消息
//      ↓
// modules/*.js        ← 各功能模块（纯逻辑，不碰 chrome 全局）
// ```
//
// 这样分层的好处很实际：模块能在 node 里直接测（注入假实现即可），
// 而 SW 本身因为依赖 `chrome.*` 全局，本来就测不动。
//
// # 只有一次 connectNative
//
// 不变式 1：**只有这里能 `connectNative`**。content script 永远拿不到端口。
// 所以 Native 端口的生命周期、请求排队、断连清理全部收敛在这个文件里。

import { ModuleRegistry } from './modules.js';
import { createVaultModule, HOST_NAME, PROTOCOL_VERSION } from './modules/vault.js';
import { createModulesModule } from './modules/registry.js';
import { createAdblockModule } from './modules/adblock.js';
import { classifySender } from './sender.js';

/**
 * 允许作为"特权 UI"的扩展页面路径白名单。
 *
 * 白名单是**穷举**的：没列在这里的扩展页面一律视为 unknown。
 * 加新页面时必须同步加进来，否则它发不出特权消息——这个"不方便"
 * 正是想要的效果：新增特权入口必须是一次显式决定。
 */
export const PRIVILEGED_PAGES = Object.freeze(['popup/popup.html', 'options/options.html']);

/** 单次 Native 请求的超时。GUI 卡住时宁可报错也不让浏览器无限等。 */
export const NATIVE_TIMEOUT_MS = 5000;

/**
 * 建一个 Native Messaging 端口管理器。
 *
 * 三件事：懒连接、按 id 配对响应、断连时把在途请求全部失败掉。
 * 最后一条尤其重要：不这样做，断连后所有在途 Promise 会永远 pending，
 * 调用方（包括 popup 的 UI）就一直转圈。
 *
 * @param {object} chromeImpl
 * @param {{timeoutMs?:number, now?:()=>number}} [opts]
 */
export function createNativePort(chromeImpl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? NATIVE_TIMEOUT_MS;
  let port = null;
  let seq = 0;
  const inflight = new Map();
  /** @type {Set<() => void>} 断连回调（让上层清掉授权等状态） */
  const onDisconnect = new Set();

  function connect() {
    if (port) return port;
    try {
      port = chromeImpl.runtime.connectNative(HOST_NAME);
    } catch {
      port = null;
      const e = new Error('NATIVE_HOST_MISSING');
      e.code = 'NATIVE_HOST_MISSING';
      throw e;
    }

    port.onMessage.addListener((msg) => {
      const pending = inflight.get(msg && msg.id);
      if (!pending) return; // 未知 id：丢弃，绝不当成有效响应
      inflight.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.payload);
      else {
        const e = new Error((msg.error && msg.error.code) || 'BRIDGE_ERROR');
        e.code = (msg.error && msg.error.code) || 'BRIDGE_ERROR';
        pending.reject(e);
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // 断连时在途请求一律失败：不能让调用方等到 5 秒超时
      for (const [, p] of inflight) {
        clearTimeout(p.timer);
        const e = new Error('HOST_DISCONNECTED');
        e.code = 'HOST_DISCONNECTED';
        p.reject(e);
      }
      inflight.clear();
      // 通知上层：授权一律作废
      for (const fn of onDisconnect) {
        try {
          fn();
        } catch {
          /* 清理出错不影响其他回调 */
        }
      }
    });

    return port;
  }

  /**
   * 发一条命令到 Native Host。
   *
   * 声明成 `async` 是刻意的：`connect()` 在 Host 没装时会**同步**抛错，
   * 不包成 async 的话调用方 `await request(...)` 会拿不到那个错误——
   * 异常在 await 之前就冒出来了，只能靠外层 try/catch 兜，极易漏掉。
   */
  async function request(cmd, payload) {
    const p = connect();
    const id = `r${Date.now().toString(36)}-${(seq += 1)}`;
    const msg = { v: PROTOCOL_VERSION, id, cmd, payload: payload || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        const e = new Error('TIMEOUT');
        e.code = 'TIMEOUT';
        reject(e);
      }, timeoutMs);
      inflight.set(id, { resolve, reject, timer });
      try {
        p.postMessage(msg);
      } catch {
        clearTimeout(timer);
        inflight.delete(id);
        const e = new Error('POST_FAILED');
        e.code = 'POST_FAILED';
        reject(e);
      }
    });
  }

  return {
    request,
    /** 已连接则返回端口，否则 null（不主动连接）。 */
    peek: () => port,
    /** 断连时回调。返回取消函数。 */
    onDisconnect: (fn) => {
      onDisconnect.add(fn);
      return () => onDisconnect.delete(fn);
    },
    /** 在途请求数，仅诊断用。 */
    inflightCount: () => inflight.size,
  };
}

/**
 * 建立宿主：把 chrome.* 注入模块并装配注册表。
 *
 * @param {object} chromeImpl 真实的 `chrome`（测试里传假实现）
 * @param {{nativeTimeoutMs?:number, registry?:ModuleRegistry, extraModules?:Array}} [opts]
 */
export function createHost(chromeImpl, opts = {}) {
  const extensionBase = chromeImpl.runtime.getURL('');
  const native = createNativePort(chromeImpl, { timeoutMs: opts.nativeTimeoutMs });

  /** 生命周期钩子的分发表。模块只登记函数，宿主负责挂到 chrome.* 上。 */
  const lifecycle = { removed: [], committed: [], disconnected: [] };

  const deps = {
    request: native.request,
    // 只用 getFrame：真实 Chrome 无 host 权限时 tabs.get 不返回 url
    getFrame: (d) => chromeImpl.webNavigation.getFrame(d),
    sendToTab: (tabId, msg, o) => chromeImpl.tabs.sendMessage(tabId, msg, o),
    crypto: chromeImpl.crypto || globalThis.crypto,
    onLifecycle: (event, fn) => {
      if (!lifecycle[event]) throw new Error(`unknown lifecycle event: ${event}`);
      lifecycle[event].push(fn);
    },
  };

  const registry = opts.registry || new ModuleRegistry();
  const vault = createVaultModule(deps);
  registry.register(vault);
  // 模块管理是**内置**模块：它自己不申请额外权限，只暴露注册表。
  // 放在这里而不是让调用方传，是因为它必须永远存在——否则设置页会空掉。
  const modulesAdmin = createModulesModule({ registry });
  registry.register(modulesAdmin);

  // 广告过滤需要 dNR。chrome 上没这个 API 时（老版本/无权限）不注册该模块，
  // 而不是让它在运行时报错——"模块列表里没有"比"模块可以点但总失败"诚实。
  let adblock = null;
  if (chromeImpl.declarativeNetRequest) {
    adblock = createAdblockModule({ dnr: chromeImpl.declarativeNetRequest });
    registry.register(adblock);
  }

  for (const m of opts.extraModules || []) registry.register(m);

  // 断连 → 清授权（模块自己登记的回调已经在 lifecycle.disconnected 里）
  /** 模块管理能做什么，测试与设置页都要知道。 */
  const CORE_MODULES = Object.freeze(['vault', 'registry']);

  native.onDisconnect(() => {
    for (const fn of lifecycle.disconnected) {
      try {
        fn();
      } catch {
        /* 清理失败不该阻断其他清理 */
      }
    }
  });

  // 挂 chrome 生命周期事件。
  //
  // **必须在模块加载时同步注册**（SW 顶层）：MV3 的 SW 随时可能被唤醒，
  // 事件监听器晚一步注册就会漏掉唤醒事件。
  chromeImpl.tabs.onRemoved.addListener((tabId) => {
    for (const fn of lifecycle.removed) fn(tabId);
  });
  chromeImpl.webNavigation.onCommitted.addListener((details) => {
    for (const fn of lifecycle.committed) fn(details);
  });

  /** 分类消息来源。 */
  function classify(sender) {
    return classifySender(sender, {
      extensionId: chromeImpl.runtime.id,
      extensionBase,
      privilegedPages: PRIVILEGED_PAGES,
    });
  }

  /**
   * 消息入口。SW 只负责把它挂到 `chrome.runtime.onMessage`。
   *
   * 返回 `true` 表示"异步回复"，这是 Chrome 的约定，漏了会让 sendResponse 失效。
   */
  function onMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') {
      sendResponse({ ok: false, error: 'BAD_MESSAGE' });
      return false;
    }

    const kind = classify(sender);
    const need = KIND_REQUIREMENT[msg.type];
    if (need && need !== 'any' && kind !== need) {
      // 来源不对：明确回错误码，而不是静默丢弃——
      // 静默会让调用方等到超时，排查时完全看不到原因。
      sendResponse({ ok: false, error: need === 'popup' ? 'PRIVILEGED_ONLY' : 'CONTENT_ONLY' });
      return false;
    }

    const ctx = { sender, kind };
    registry
      .dispatch(msg.type, msg, ctx)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.code) || 'DISPATCH_FAILED') }));
    return true;
  }

  return {
    registry,
    native,
    onMessage,
    classify,
    vault,
    modulesAdmin,
    adblock,
    /** 核心模块清单：设置页不允许关闭它们。 */
    CORE_MODULES,
  };
}

/**
 * 消息类型 → 允许的来源。
 *
 * 放在模块外面而不是让模块自己声明，因为「谁能发这条消息」是**宿主级**的
 * 来源策略，和具体业务逻辑无关。集中在一张表里，一眼能看出攻击面。
 *
 * 未列出的类型默认 `any`（比如 `content-ready` 只做握手，无副作用）。
 */
export const KIND_REQUIREMENT = Object.freeze({
  // 只读 + 签发授权：必须是用户主动打开的扩展页面
  query: 'popup',
  'authorize-fill': 'popup',
  // 兑换与握手：只能是网页里的 content script
  'redeem-fill': 'content',
  'content-ready': 'content',
  // status 谁都能问（不含任何密码），opener 也允许
  status: 'any',
  // 设置页自己读模块清单（不含任何密码或密钥）
  'modules.list': 'popup',
  'modules.set-enabled': 'popup',
  // 广告过滤：只有扩展页面能改规则或问诊断；explain 无副作用但也没必要开放
  'adblock.apply': 'popup',
  'adblock.status': 'popup',
  'adblock.explain': 'popup',
});
