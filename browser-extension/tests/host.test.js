// 宿主层测试：Native 端口 + 消息来源门禁。
//
// 这两块是重构后风险最高的地方：
//   - Native 端口是**唯一**能 connectNative 的地方，它的断连/超时处理错了，
//     整个扩展的所有请求都会挂
//   - 消息来源门禁错了，攻击面立刻扩大（content script 就能签发授权）
//
// 所以用假 chrome.* 把它们完整测一遍。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost, createNativePort, KIND_REQUIREMENT } from '../lib/host.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_BASE = `chrome-extension://${EXT_ID}/`;

/**
 * 假 chrome：记录所有调用，并能手动触发端口事件。
 *
 * 刻意做得"笨"——只实现扩展真正用到的那几个成员。
 * 实现得越全，越容易掩盖"其实调用了不存在的东西"。
 */
function fakeChrome() {
  const listeners = { message: [], removed: [], committed: [] };
  const posted = [];
  let disconnectFn = null;
  let messageFn = null;
  let connectCount = 0;
  let throwOnConnect = false;

  const port = {
    postMessage(msg) {
      posted.push(msg);
    },
    onMessage: {
      addListener(fn) {
        messageFn = fn;
      },
    },
    onDisconnect: {
      addListener(fn) {
        disconnectFn = fn;
      },
    },
  };

  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: () => EXT_BASE,
      connectNative(name) {
        connectCount += 1;
        if (throwOnConnect) throw new Error('no host');
        return port;
      },
      onMessage: {
        addListener(fn) {
          listeners.message.push(fn);
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) {
          listeners.removed.push(fn);
        },
      },
      sendMessage: async () => ({ ok: true }),
    },
    webNavigation: {
      onCommitted: {
        addListener(fn) {
          listeners.committed.push(fn);
        },
      },
      getFrame: async ({ tabId, frameId }) => ({
        url: 'https://example.test/login',
        documentId: `doc-${tabId}-${frameId}`,
      }),
    },
    crypto: {
      getRandomValues(a) {
        for (let i = 0; i < a.length; i += 1) a[i] = i;
        return a;
      },
    },
  };

  return {
    chrome,
    posted,
    listeners,
    /** 模拟 Host 回包 */
    reply: (msg) => messageFn && messageFn(msg),
    /** 模拟端口断开 */
    disconnect: () => disconnectFn && disconnectFn(),
    /** 模拟启动时 connectNative 抛错 */
    setThrowOnConnect: (v) => {
      throwOnConnect = v;
    },
    counts: () => ({ connect: connectCount }),
    /** 清空已记录的消息，方便断言"这次发了什么" */
    reset: () => {
      posted.length = 0;
    },
  };
}

/** 等到第 n 条请求真的发出来了（handler 里有 await，需要让出几个微任务）。 */
async function waitPosted(f, n = 1) {
  for (let i = 0; i < 200 && f.posted.length < n; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  return f.posted[n - 1];
}

/* --------------------------- Native 端口 --------------------------- */

test('PASS: 懒连接 —— 不请求就不连', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  assert.equal(f.counts().connect, 0);
  assert.equal(p.peek(), null);
});

test('PASS: 首次请求才连接，且只连一次', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  const a = p.request('status', {});
  const b = p.request('query', { o: 1 });
  assert.equal(f.counts().connect, 1, '两次请求应该复用同一个端口');
  assert.equal(p.inflightCount(), 2);

  f.reply({ id: f.posted[0].id, ok: true, payload: { locked: false } });
  f.reply({ id: f.posted[1].id, ok: true, payload: [] });
  assert.deepEqual(await a, { locked: false });
  assert.deepEqual(await b, []);
  assert.equal(p.inflightCount(), 0);
});

test('PASS: 请求帧形状符合协议', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome, { timeoutMs: 20 });
  const req = p.request('vault.query', { origin: 'https://example.test' });
  // 这条请求不会被回包，测试结束时会超时——显式吞掉，避免污染后续用例
  req.catch(() => {});
  const frame = f.posted[0];
  assert.equal(frame.v, 1);
  assert.equal(frame.cmd, 'vault.query');
  assert.deepEqual(frame.payload, { origin: 'https://example.test' });
  assert.equal(typeof frame.id, 'string');
  assert.ok(frame.id.length > 0);
});

test('FAIL-SAFE: Host 回 ok:false 时 reject 并带上稳定错误码', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  const req = p.request('vault.fill', {});
  f.reply({ id: f.posted[0].id, ok: false, error: { code: 'VAULT_LOCKED' } });
  await assert.rejects(req, (e) => e.code === 'VAULT_LOCKED');
});

test('FAIL-SAFE: 未知 id 的响应被丢弃，不影响在途请求', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  const req = p.request('status', {});
  f.reply({ id: 'not-a-real-id', ok: true, payload: { evil: true } });
  assert.equal(p.inflightCount(), 1, '不该把陌生响应算进在途');
  f.reply({ id: f.posted[0].id, ok: true, payload: { good: true } });
  assert.deepEqual(await req, { good: true });
});

test('FAIL-SAFE: 断连时在途请求全部失败，不等超时', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome, { timeoutMs: 10000 });
  const a = p.request('status', {});
  const b = p.request('query', {});
  f.disconnect();
  // 如果没清理，这两个会挂到 timeoutMs 才 reject（测试就会超时）
  await assert.rejects(a, (e) => e.code === 'HOST_DISCONNECTED');
  await assert.rejects(b, (e) => e.code === 'HOST_DISCONNECTED');
  assert.equal(p.inflightCount(), 0);
});

test('PASS: 断连后再次请求会重连（不是永久失效）', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  const first = p.request('status', {});
  f.disconnect();
  await assert.rejects(first, (e) => e.code === 'HOST_DISCONNECTED');

  const second = p.request('status', {});
  assert.equal(f.counts().connect, 2, '应该建了新端口');
  f.reply({ id: f.posted[f.posted.length - 1].id, ok: true, payload: { ok: 1 } });
  assert.deepEqual(await second, { ok: 1 });
});

test('PASS: 断连会通知所有登记的回调', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  let hits = 0;
  p.onDisconnect(() => {
    hits += 1;
  });
  p.onDisconnect(() => {
    hits += 1;
  });
  p.request('status', {}).catch(() => {});
  f.disconnect();
  assert.equal(hits, 2);
});

test('PASS: 其中一个断连回调抛错，不影响其他回调', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  let reached = false;
  p.onDisconnect(() => {
    throw new Error('boom');
  });
  p.onDisconnect(() => {
    reached = true;
  });
  p.request('status', {}).catch(() => {});
  f.disconnect();
  assert.equal(reached, true);
});

test('FAIL-SAFE: connectNative 抛错时返回 NATIVE_HOST_MISSING', async () => {
  const f = fakeChrome();
  f.setThrowOnConnect(true);
  const p = createNativePort(f.chrome);
  await assert.rejects(() => p.request('status', {}), (e) => e.code === 'NATIVE_HOST_MISSING');
});

test('FAIL-SAFE: postMessage 抛错时清掉在途，不留幽灵', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome);
  // 第一次 request 建立端口后，替换掉 postMessage 让它抛
  const origConnect = f.chrome.runtime.connectNative;
  let portRef = null;
  f.chrome.runtime.connectNative = (name) => {
    portRef = origConnect.call(f.chrome.runtime, name);
    portRef.postMessage = () => {
      throw new Error('port closed');
    };
    return portRef;
  };
  await assert.rejects(() => p.request('status', {}), (e) => e.code === 'POST_FAILED');
  assert.equal(p.inflightCount(), 0);
});

test('FAIL-SAFE: 超时后清掉在途并带 TIMEOUT 码', async () => {
  const f = fakeChrome();
  const p = createNativePort(f.chrome, { timeoutMs: 20 });
  await assert.rejects(() => p.request('status', {}), (e) => e.code === 'TIMEOUT');
  assert.equal(p.inflightCount(), 0);
  // 迟到的响应不该再被当成有效回包
  f.reply({ id: f.posted[0].id, ok: true, payload: { late: true } });
});

/* --------------------------- 消息来源门禁 --------------------------- */

const POPUP_SENDER = { id: EXT_ID, url: `${EXT_BASE}popup/popup.html` };
const CONTENT_SENDER = { id: EXT_ID, url: 'https://example.test/login', tab: { id: 5 }, frameId: 0 };
const SELF_SENDER = { id: EXT_ID, url: `${EXT_BASE}background/service-worker.js` };

async function setup() {
  const f = fakeChrome();
  const host = await createHost(f.chrome, { nativeTimeoutMs: 50 });
  return { f, host };
}

/** 走一遍 onMessage，拿到同步/异步回复。 */
function deliver(host, msg, sender) {
  return new Promise((resolve) => {
    const ret = host.onMessage(msg, sender, resolve);
    if (ret !== true) resolve(undefined);
  });
}

test('PASS: 门禁表本身是冻结的（改不了攻击面）', async () => {
  assert.equal(Object.isFrozen(KIND_REQUIREMENT), true);
});

test('PASS: popup 可以发 query 与 authorize-fill', async () => {
  const { f, host } = await setup();
  const p = deliver(host, { type: 'query', tabId: 5 }, POPUP_SENDER);
  const frame = await waitPosted(f, 1);
  f.reply({ id: frame.id, ok: true, payload: [] });
  const res = await p;
  // query 成功时回 origin + entries
  assert.equal(res.ok, true);
  assert.equal(Array.isArray(res.entries), true);
});

test('FAIL-SAFE: content script 不能发 query', async () => {
  const { host } = await setup();
  const res = await deliver(host, { type: 'query', tabId: 5 }, CONTENT_SENDER);
  assert.deepEqual(res, { ok: false, error: 'PRIVILEGED_ONLY' });
});

test('FAIL-SAFE: content script 不能发 authorize-fill', async () => {
  const { host } = await setup();
  const res = await deliver(
    host,
    { type: 'authorize-fill', tabId: 5, entryId: 'x' },
    CONTENT_SENDER
  );
  assert.deepEqual(res, { ok: false, error: 'PRIVILEGED_ONLY' });
});

test('FAIL-SAFE: popup 不能发 redeem-fill（只有 content script 能）', async () => {
  const { host } = await setup();
  const res = await deliver(host, { type: 'redeem-fill', nonce: 'x', entryId: 'y' }, POPUP_SENDER);
  assert.deepEqual(res, { ok: false, error: 'CONTENT_ONLY' });
});

test('FAIL-SAFE: SW 自己发的消息不被信任', async () => {
  const { host } = await setup();
  // 这就是重构时踩过的坑：在 SW 里 sendMessage 给自己，classify 判成 unknown
  for (const type of ['query', 'authorize-fill', 'redeem-fill']) {
    const res = await deliver(host, { type, tabId: 5, entryId: 'x', nonce: 'n' }, SELF_SENDER);
    assert.equal(res.ok, false, type);
    assert.ok(['PRIVILEGED_ONLY', 'CONTENT_ONLY'].includes(res.error), `${type} → ${res.error}`);
  }
});

test('FAIL-SAFE: 缺 type / 空消息被拒绝', async () => {
  const { host } = await setup();
  assert.deepEqual(await deliver(host, null, POPUP_SENDER), { ok: false, error: 'BAD_MESSAGE' });
  assert.deepEqual(await deliver(host, {}, POPUP_SENDER), { ok: false, error: 'BAD_MESSAGE' });
  assert.deepEqual(await deliver(host, { type: 123 }, POPUP_SENDER), {
    ok: false,
    error: 'BAD_MESSAGE',
  });
});

test('PASS: status 谁都问得到（不含密码）', async () => {
  const { f, host } = await setup();
  const p = deliver(host, { type: 'status' }, CONTENT_SENDER);
  const frame = await waitPosted(f, 1);
  f.reply({ id: frame.id, ok: true, payload: { locked: false, protocol: 1 } });
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.data.locked, false);
});

test('FAIL-SAFE: 未知消息类型回 UNKNOWN_TYPE 而非静默', async () => {
  const { host } = await setup();
  const res = await deliver(host, { type: 'nope.nothing' }, POPUP_SENDER);
  assert.deepEqual(res, { ok: false, error: 'UNKNOWN_TYPE' });
});

test('PASS: 异步回复返回 true（Chrome 的异步约定）', async () => {
  const { host } = await setup();
  const ret = host.onMessage({ type: 'status' }, CONTENT_SENDER, () => {});
  assert.equal(ret, true, '异步分支必须返回 true，否则 sendResponse 会失效');
});

/* --------------------------- 生命周期接线 --------------------------- */

test('PASS: tabs.onRemoved 与 webNavigation.onCommitted 在建立宿主时就挂上', async () => {
  const f = fakeChrome();
  await createHost(f.chrome);
  assert.equal(f.listeners.removed.length, 1);
  assert.equal(f.listeners.committed.length, 1);
});

test('PASS: 端口断连会清掉填充授权', async () => {
  const { f, host } = await setup();
  // 先签一个授权（走真实路径：query 复查条目 → sendMessage 到 tab）
  const entryId = 'e1';
  const authP = deliver(
    host,
    { type: 'authorize-fill', tabId: 5, entryId },
    POPUP_SENDER
  );
  // authorize-fill 内部先 request('vault.query')
  const frame = await waitPosted(f, 1);
  f.reply({ id: frame.id, ok: true, payload: [{ id: entryId }] });
  const auth = await authP;
  assert.equal(auth.ok, true, JSON.stringify(auth));
  assert.equal(typeof auth.nonce, 'string');

  // 断连 → 授权应作废
  f.disconnect();

  // 用旧 nonce 兑换必须失败
  const redeemP = deliver(host, { type: 'redeem-fill', nonce: auth.nonce, entryId }, CONTENT_SENDER);
  const res = await redeemP;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'AUTH_REJECTED');
});

test('PASS: tab 关闭后该 tab 的授权失效', async () => {
  const { f, host } = await setup();
  const entryId = 'e2';
  const authP = deliver(host, { type: 'authorize-fill', tabId: 9, entryId }, POPUP_SENDER);
  const frame = await waitPosted(f, 1);
  f.reply({ id: frame.id, ok: true, payload: [{ id: entryId }] });
  const auth = await authP;
  assert.equal(auth.ok, true);

  for (const fn of f.listeners.removed) fn(9);

  const res = await deliver(
    host,
    { type: 'redeem-fill', nonce: auth.nonce, entryId },
    { ...CONTENT_SENDER, tab: { id: 9 } }
  );
  assert.equal(res.ok, false);
});

test('PASS: 主框架导航后授权失效', async () => {
  const { f, host } = await setup();
  const entryId = 'e3';
  const authP = deliver(host, { type: 'authorize-fill', tabId: 11, entryId }, POPUP_SENDER);
  const frame = await waitPosted(f, 1);
  f.reply({ id: frame.id, ok: true, payload: [{ id: entryId }] });
  const auth = await authP;
  assert.equal(auth.ok, true);

  for (const fn of f.listeners.committed) fn({ tabId: 11, frameId: 0 });

  const res = await deliver(
    host,
    { type: 'redeem-fill', nonce: auth.nonce, entryId },
    { ...CONTENT_SENDER, tab: { id: 11 } }
  );
  assert.equal(res.ok, false);
});

/* --------------------------- 模块接线 --------------------------- */

test('PASS: 宿主自动注册了 vault 模块', async () => {
  const { host } = await setup();
  const ids = host.registry.list().map((m) => m.id);
  assert.deepEqual(ids, ['vault', 'registry']);
});

test('PASS: vault 模块声明的权限与 manifest 现状一致', async () => {
  const { host } = await setup();
  const need = host.registry.requiredManifestPermissions();
  // registry 的 configStore 会贡献 storage
  assert.deepEqual(need.permissions, [
    'activeTab',
    'nativeMessaging',
    'scripting',
    'storage',
    'webNavigation',
  ]);
  assert.deepEqual(need.hostPermissions, ['https://*/*']);
});

test('PASS: 额外模块能被注入并参与分派', async () => {
  const f = fakeChrome();
  const host = await createHost(f.chrome, {
    extraModules: [
      {
        id: 'extra',
        title: '演示模块',
        requires: ['contentScript'],
        handlers: [{ type: 'extra.ping', handle: () => ({ ok: true, pong: true }) }],
      },
    ],
  });
  const res = await deliver(host, { type: 'extra.ping' }, POPUP_SENDER);
  assert.deepEqual(res, { ok: true, pong: true });
});

test('FAIL-SAFE: 额外模块的坏定义在启动时就炸，不带病运行', async () => {
  // createHost 是 async，所以坏定义表现为 rejected promise 而不是同步 throw。
  // 语义一样：宿主建不起来，不会有"带病运行"的宿主。
  const f = fakeChrome();
  await assert.rejects(() =>
    createHost(f.chrome, { extraModules: [{ id: 'Bad', title: 'x' }] })
  );
});
