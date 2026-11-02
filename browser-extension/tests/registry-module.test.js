// 设置页模块（registry）与「模块不可被关掉」约束的测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../lib/host.js';
import { ModuleRegistry } from '../lib/modules.js';
import { createModulesModule } from '../lib/modules/registry.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_BASE = `chrome-extension://${EXT_ID}/`;

const POPUP = { id: EXT_ID, url: `${EXT_BASE}popup/popup.html` };
const OPTIONS = { id: EXT_ID, url: `${EXT_BASE}options/options.html` };
const CONTENT = { id: EXT_ID, url: 'https://example.test/', tab: { id: 1 }, frameId: 0 };
const SELF = { id: EXT_ID, url: `${EXT_BASE}background/service-worker.js` };

function fakeChrome() {
  const listeners = { message: [], removed: [], committed: [] };
  let messageFn = null;
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: () => EXT_BASE,
      connectNative: () => ({
        postMessage() {},
        onMessage: { addListener: (fn) => { messageFn = fn; } },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    tabs: {
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
      sendMessage: async () => ({ ok: true }),
    },
    webNavigation: {
      onCommitted: { addListener: (fn) => listeners.committed.push(fn) },
      getFrame: async () => ({ url: 'https://example.test/', documentId: 'd1' }),
    },
    crypto: { getRandomValues: (a) => a },
  };
  return { chrome, messageFn: () => messageFn };
}

function deliver(host, msg, sender) {
  return new Promise((resolve) => {
    const ret = host.onMessage(msg, sender, resolve);
    if (ret !== true) resolve(undefined);
  });
}

/* --------------------------- 权限边界 --------------------------- */

test('PASS: options 页面被识别为特权页面（与 popup 同级）', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  assert.equal(host.classify(OPTIONS), 'popup');
  assert.equal(host.classify(POPUP), 'popup');
});

test('FAIL-SAFE: 其它扩展页面（非白名单）仍是 unknown', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  for (const p of ['background/service-worker.js', 'options/other.html', 'content/x.js']) {
    assert.equal(host.classify({ id: EXT_ID, url: `${EXT_BASE}${p}` }), 'unknown', p);
  }
});

test('FAIL-SAFE: content script 不能读模块列表', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(host, { type: 'modules.list' }, CONTENT);
  assert.deepEqual(res, { ok: false, error: 'PRIVILEGED_ONLY' });
});

test('FAIL-SAFE: content script 不能开关模块', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'vault', enabled: false },
    CONTENT
  );
  assert.deepEqual(res, { ok: false, error: 'PRIVILEGED_ONLY' });
});

test('FAIL-SAFE: SW 自己不能开关模块', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'vault', enabled: false },
    SELF
  );
  assert.deepEqual(res, { ok: false, error: 'PRIVILEGED_ONLY' });
});

/* --------------------------- 列表内容 --------------------------- */

test('PASS: 模块列表包含元数据与权限，且不含任何密钥字段', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(host, { type: 'modules.list' }, OPTIONS);

  assert.equal(res.ok, true);
  assert.equal(Array.isArray(res.modules), true);
  assert.ok(res.modules.length >= 2);

  const vault = res.modules.find((m) => m.id === 'vault');
  assert.ok(vault);
  assert.equal(vault.title, '密码填充');
  assert.equal(vault.enabled, true);
  assert.ok(Array.isArray(vault.requires));
  assert.ok(vault.requires.includes('nativeMessaging'));

  // 整个响应里不许出现任何疑似密钥的键名
  const json = JSON.stringify(res).toLowerCase();
  for (const forbidden of ['password', 'secret', 'token', 'apikey', 'masterkey']) {
    assert.equal(json.includes(forbidden), false, `响应里出现了 ${forbidden}`);
  }
});

test('PASS: 列表带上由模块反推的 manifest 权限', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(host, { type: 'modules.list' }, OPTIONS);
  assert.deepEqual(res.manifest.permissions.sort(), [
    'activeTab',
    'nativeMessaging',
    'scripting',
    'storage',
    'webNavigation',
  ]);
  assert.deepEqual(res.manifest.hostPermissions, ['https://*/*']);
});

test('PASS: 模块管理只申请扩展页面与设置持久化', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(host, { type: 'modules.list' }, OPTIONS);
  const reg = res.modules.find((m) => m.id === 'registry');
  assert.ok(reg);
  assert.deepEqual([...reg.requires].sort(), ['configStore', 'extensionPages']);
});

/* --------------------------- 开关 --------------------------- */

test('FAIL-SAFE: vault 不允许被关掉', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'vault', enabled: false },
    OPTIONS
  );
  assert.deepEqual(res, { ok: false, error: 'MODULE_REQUIRED' });
  assert.equal(host.registry.isEnabled('vault'), true, '被拒后不该真的关掉');
});

test('FAIL-SAFE: registry 不允许被关掉（否则设置页失去自我描述）', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const res = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'registry', enabled: false },
    OPTIONS
  );
  assert.deepEqual(res, { ok: false, error: 'MODULE_REQUIRED' });
});

test('PASS: 普通模块可以被关掉并真的停用', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome, {
    extraModules: [
      {
        id: 'reader',
        title: '阅读模式',
        requires: ['contentScript'],
        handlers: [{ type: 'reader.toggle', handle: () => ({ ok: true }) }],
      },
    ],
  });

  const off = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'reader', enabled: false },
    OPTIONS
  );
  assert.equal(off.ok, true);
  assert.equal(host.registry.isEnabled('reader'), false);

  // 关掉后它的消息被拒
  const res = await deliver(host, { type: 'reader.toggle' }, OPTIONS);
  assert.deepEqual(res, { ok: false, error: 'MODULE_DISABLED' });

  // 再打开
  const on = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'reader', enabled: true },
    OPTIONS
  );
  assert.equal(on.ok, true);
  assert.deepEqual(await deliver(host, { type: 'reader.toggle' }, OPTIONS), { ok: true });
});

test('FAIL-SAFE: 开关参数缺 id 或类型不对被拒', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  const cases = [
    { type: 'modules.set-enabled', enabled: true },
    { type: 'modules.set-enabled', id: '', enabled: true },
    { type: 'modules.set-enabled', id: 'vault' },
    { type: 'modules.set-enabled', id: 'vault', enabled: 'true' },
  ];
  for (const msg of cases) {
    const res = await deliver(host, msg, OPTIONS);
    assert.deepEqual(res, { ok: false, error: 'BAD_ARGS' }, JSON.stringify(msg));
  }
});

test('FAIL-SAFE: 不存在的模块 id 被拒', async () => {
  const { chrome } = fakeChrome();
  const host = await createHost(chrome);
  // registry.setEnabled 对未注册模块抛 UNKNOWN_MODULE，dispatch 捕获后转成错误码
  const res = await deliver(
    host,
    { type: 'modules.set-enabled', id: 'ghost', enabled: true },
    OPTIONS
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'UNKNOWN_MODULE');
});

/* --------------------------- 独立构造 --------------------------- */

test('PASS: createModulesModule 可单独构造（不依赖宿主）', async () => {
  const registry = new ModuleRegistry();
  registry.register({
    id: 'demo',
    title: '演示',
    requires: ['contentScript'],
    handlers: [{ type: 'demo.x', handle: () => ({ ok: true }) }],
  });
  const mod = createModulesModule({ registry });
  const res = await mod.handlers.find((h) => h.type === 'modules.list').handle({}, {});
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.modules.map((m) => m.id),
    ['demo']
  );
});
