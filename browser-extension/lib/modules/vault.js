// 「密码填充」模块 —— 把原来 service-worker.js 里的业务逻辑搬进来。
//
// # 搬运原则
//
// **行为等于搬家**：一行逻辑都不改，只换位置与依赖注入方式。
// 阶段 2.6–2.7.4 在真实 Chrome 里验证过的每一条不变式都必须原样保留：
//
//   1. 只有这里能 `connectNative`。content script 永远拿不到端口。
//   2. 密码只在本模块的局部变量里短暂存在，绝不写 storage、绝不进日志。
//   3. 填充授权是一次性、短时效、绑定 tab/frame/origin/entry 的**状态机**。
//
// 改动只有两种：
//   - 依赖从"直接读全局 chrome.*"改成"由宿主注入"，方便在 node 里跑；
//   - 消息类型集中声明在这儿，而不是散在 if 链里。
//
// # 那些不变式为什么原样保留
//
// 阶段 2.7.4 的真实 Chrome 验收（17 项）就是照着这些行为写的。
// 搬家时任何一条改变，那 17 项都会挂——这正是重构该有的安全网。

import { normalize, isFillable } from '../origin.js';
import { AuthStore } from '../auth-store.js';
import { redeemFill, resolveFrame } from '../redeem.js';

/** 授权有效期：用户点完到真正兑换，中间只该隔几十毫秒。 */
export const AUTH_TTL_MS = 5000;

/** Native Host 的名字，必须与注册清单里的一致。 */
export const HOST_NAME = 'com.keynest.bridge';

/** 协议版本。改协议要同时改 Rust 侧与这里，并升版本号。 */
export const PROTOCOL_VERSION = 1;

/**
 * 单调时钟：不受系统时间调整影响。
 *
 * 详细理由见阶段 2.7.1 报告：`Date.now()` 会被系统时间调整拉回或推前，
 * 往回调会让已到期的授权"复活"，等于非法延长有效期。
 *
 * SW 重启后 `performance.now()` 归零，但那时 `auths` 本来也空了，语义一致。
 * 异常时返回 NaN → `AuthStore` 视为已过期（保守方向），**绝不回退 Date.now()**。
 */
export function monotonicNow() {
  try {
    const t = performance.now();
    return Number.isFinite(t) ? t : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** 32 hex 的一次性 nonce，用 CSPRNG 生成。 */
export function cryptoNonce(cryptoImpl) {
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 建一个密码填充模块。
 *
 * @param {object} deps 由宿主注入的真实实现（测试里换成假实现）
 * @param {(cmd:string, payload:object)=>Promise<unknown>} deps.request 发往 Native Host
 * @param {(d:{tabId:number, frameId:number})=>Promise<object>} deps.getFrame webNavigation.getFrame
 * @param {(tabId:number, msg:object, opts:object)=>Promise<unknown>} deps.sendToTab tabs.sendMessage
 * @param {(event:'removed'|'committed', fn:Function)=>void} deps.onLifecycle 注册生命周期钩子
 * @param {{getRandomValues(a:Uint8Array):Uint8Array}} deps.crypto
 * @param {()=>void} [deps.onPasswordCleared] 断连时清理引用（当前为空操作，留作审计点）
 */
export function createVaultModule(deps) {
  const auths = new AuthStore(monotonicNow, AUTH_TTL_MS);

  /**
   * 兑换（注入 chrome.* 的真实实现）。
   *
   * 并发安全与 frame 校验逻辑都在 lib/redeem.js —— 那样才能在 node 里做真并发测试。
   * 这里不做任何逻辑判断。
   */
  function redeemWithChrome(nonce, claimed) {
    return redeemFill(
      auths,
      {
        // 只用 getFrame：真实 Chrome 无 host 权限时 tabs.get 不返回 url
        getFrame: deps.getFrame,
        fill: (req) => deps.request('vault.fill', req),
      },
      nonce,
      claimed
    );
  }

  /** 签发授权。**不取密码**——密码要等到 redeem 通过校验后才取。 */
  function issueAuth({ tabId, frameId, origin, entryId, username, documentId, topDocumentId }) {
    const nonce = cryptoNonce(deps.crypto);
    auths.issue(nonce, { tabId, frameId, origin, entryId, username, documentId, topDocumentId });
    return { nonce };
  }

  /**
   * 只读查询：绝不返回密码。
   *
   * origin 的唯一可信来源是 getFrame——真实 Chrome 无 host 权限时
   * `tabs.get(tabId).url` 是 undefined，用它必然 NO_ORIGIN。
   */
  async function handleQuery(msg) {
    const tabId = msg.tabId;
    const frame = await resolveFrame(deps, tabId, 0);
    if (!frame) return { ok: false, error: 'NO_ORIGIN' };
    if (!isFillable(frame.origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

    const list = await deps.request('vault.query', { origin: frame.origin });
    return { ok: true, origin: frame.origin, entries: Array.isArray(list) ? list : [] };
  }

  /** 第一步：签发授权并把 nonce 交给 content script（**不含密码**）。 */
  async function handleAuthorize(msg) {
    const tabId = msg.tabId;
    const entryId = String(msg.entryId || '');
    if (!Number.isInteger(tabId) || !entryId) return { ok: false, error: 'BAD_ARGS' };

    // 目标 frame（当前只授权主框架 frameId=0）
    const targetFrame = await resolveFrame(deps, tabId, 0);
    if (!targetFrame) return { ok: false, error: 'NO_ORIGIN' };
    if (!isFillable(targetFrame.origin)) return { ok: false, error: 'HTTP_NOT_ALLOWED' };

    // 顶层文档身份（当前与目标相同，仍单独取一次以便将来支持 iframe）
    const topFrame = await resolveFrame(deps, tabId, 0);
    if (!topFrame || !topFrame.documentId) return { ok: false, error: 'NO_ORIGIN' };

    // 先向 KeyNest 复查条目是否属于该 origin（不取密码，只查元数据）
    const list = await deps.request('vault.query', { origin: targetFrame.origin });
    if (!Array.isArray(list) || !list.some((e) => e.id === entryId)) {
      return { ok: false, error: 'ENTRY_NOT_MATCHED' };
    }

    const frameId = 0;
    const username = typeof msg.username === 'string' ? msg.username.slice(0, 320) : '';
    const { nonce } = issueAuth({
      tabId,
      frameId,
      origin: targetFrame.origin,
      entryId,
      username,
      documentId: targetFrame.documentId,
      topDocumentId: topFrame.documentId,
    });

    try {
      await deps.sendToTab(tabId, { type: 'prepare-fill', nonce, origin: targetFrame.origin }, { frameId });
    } catch {
      auths.invalidate(nonce);
      return { ok: false, error: 'NO_CONTENT_SCRIPT' };
    }

    return { ok: true, nonce };
  }

  /** 第二步：content script 出示 nonce 兑换密码。 */
  async function handleRedeem(msg, ctx) {
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : '';
    if (!nonce) return { ok: false, error: 'NO_NONCE' };

    const out = await redeemWithChrome(nonce, {
      tabId: ctx.sender.tab && ctx.sender.tab.id,
      frameId: Number.isInteger(ctx.sender.frameId) ? ctx.sender.frameId : 0,
      origin: normalize(ctx.sender.url || ''),
      entryId: msg.entryId,
    });

    if (!out.ok) return out;
    return { ok: true, username: out.username, password: out.password };
  }

  // ---- 生命周期：导航 / tab 关闭 / 断连 都要让旧授权失效 ----
  //
  // 当前只授权 frameId=0，所以主框架导航即让该 tab 全部授权失效。
  deps.onLifecycle('removed', (tabId) => auths.invalidateTab(tabId));
  deps.onLifecycle('committed', (details) =>
    auths.invalidateNavigation(details.tabId, details.frameId)
  );
  deps.onLifecycle('disconnected', () => auths.clear());

  // SW 每次启动都是新执行环境：内存里的 auths 天然为空。
  // 显式清一次，表明这是有意为之而非巧合。
  auths.clear();

  return {
    id: 'vault',
    title: '密码填充',
    description: '从本地钥巢密码库填充网页登录表单，不读取也不写入浏览器内置密码库',
    // 本模块是既有的核心能力，默认启用。
    // （是否允许在设置里关掉，由 UI 层决定——关掉它这个扩展就没有存在意义，
    // 所以设置页会把它显示为不可关闭。这里只管默认值。）
    defaultEnabled: true,
    requires: ['nativeMessaging', 'activeTab', 'scripting', 'webNavigation', 'hostHttps'],
    handlers: [
      // status 的线上形状是 `{ok:true, data:{locked,protocol,version}}`——
      // 外层 ok 是扩展协议，data 才是 Native Host 的 payload。
      // 这里必须显式包装：popup 与真实 Chrome 验收都按这个形状断言。
      {
        type: 'status',
        handle: async () => ({ ok: true, data: await deps.request('status', {}) }),
      },
      { type: 'query', handle: handleQuery },
      { type: 'authorize-fill', handle: handleAuthorize },
      { type: 'redeem-fill', handle: (msg, ctx) => handleRedeem(msg, ctx) },
      // content-ready 只是 content script 的握手信号，不需要业务逻辑
      { type: 'content-ready', handle: () => ({ ok: true }) },
    ],
  };
}
