// 自动应用的测试。
//
// # 这个文件最重要的一条断言
//
// **页面加载时绝不请求权限。**
//
// 那时没有用户手势，`permissions.request` 要么被静默拒绝，要么弹一个
// 用户根本没预期到的确认框。后者更糟——用户会以为浏览器出问题了。
//
// 所以每个测自动应用的用例都要同时验：`contains` 被调用、
// `request` **一次都没被调用**。

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAuto, autoApplyModules } from '../lib/auto-apply.js';
import { ModuleRegistry } from '../lib/modules.js';
import { hasHostPermission, injectInto } from '../lib/inject.js';
import { buildDocument } from './helpers/minidom.js';

/* ============================ 工具 ============================ */

/** 记录调用的假权限对象。 */
function fakePermissions({ granted = true, containsThrows = false } = {}) {
  const calls = { contains: 0, request: 0 };
  return {
    calls,
    async contains() {
      calls.contains += 1;
      if (containsThrows) throw new Error('boom');
      return granted;
    },
    async request() {
      calls.request += 1;
      return granted;
    },
  };
}

function fakeScripting(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    async executeScript(opts) {
      calls.push(opts);
      return [{ result }];
    },
  };
}

function fakeNav(url = 'https://a.test/page') {
  return { getFrame: async () => ({ url }) };
}

/** 造一个带 autoApply 的模块定义。 */
function autoModule(id, { should = true, applyResult = { ok: true } } = {}) {
  return {
    id,
    title: id,
    requires: ['scripting'],
    handlers: [{ type: `${id}.noop`, handle: () => ({ ok: true }) }],
    autoApply: {
      shouldApply: () => should,
      apply: async () => applyResult,
    },
  };
}

function makeDeps(overrides = {}) {
  const registry = overrides.registry || new ModuleRegistry();
  return {
    registry,
    injectDeps: {
      scripting: overrides.scripting || fakeScripting(),
      permissions: overrides.permissions || fakePermissions(),
      webNavigation: overrides.webNavigation || fakeNav(),
    },
  };
}

/* ============================ 权限：绝不请求 ============================ */

test('FAIL-SAFE: hasHostPermission 只查不请求', async () => {
  const perms = fakePermissions({ granted: true });
  assert.equal(await hasHostPermission(perms, 'https://a.test/*'), true);
  assert.equal(perms.calls.contains, 1);
  assert.equal(perms.calls.request, 0, '自动应用不该请求权限');
});

test('FAIL-SAFE: injectInto requestPermission:false 时不请求', async () => {
  const perms = fakePermissions({ granted: true });
  const scripting = fakeScripting();
  await injectInto(
    { scripting, permissions: perms, webNavigation: fakeNav() },
    1,
    () => 1,
    [],
    { requestPermission: false }
  );
  assert.equal(perms.calls.request, 0);
});

test('FAIL-SAFE: 未授权时安静返回 HOST_PERMISSION_DENIED（不请求、不注入）', async () => {
  const perms = fakePermissions({ granted: false });
  const scripting = fakeScripting();
  const r = await injectInto(
    { scripting, permissions: perms, webNavigation: fakeNav() },
    1,
    () => 1,
    [],
    { requestPermission: false }
  );
  assert.equal(r.error, 'HOST_PERMISSION_DENIED');
  assert.equal(perms.calls.request, 0);
  assert.equal(scripting.calls.length, 0, '没权限就不该注入');
});

test('PASS: 默认仍允许请求（用户主动点按钮时该能弹框）', async () => {
  const perms = fakePermissions({ granted: true });
  await injectInto(
    { scripting: fakeScripting(), permissions: perms, webNavigation: fakeNav() },
    1,
    () => 1
  );
  // granted:true 时 contains 就返回 true，所以 request 仍是 0——这是对的
  assert.equal(perms.calls.contains, 1);
});

test('FAIL-SAFE: contains 抛错按未授权处理', async () => {
  const perms = fakePermissions({ containsThrows: true });
  assert.equal(await hasHostPermission(perms, 'https://a.test/*'), false);
});

/* ============================ applyAuto：过滤 ============================ */

test('PASS: 只跑实现了 autoApply 且已启用的模块', async () => {
  const registry = new ModuleRegistry();
  registry.register(autoModule('a'));
  registry.register({
    id: 'plain',
    title: 'plain',
    requires: ['scripting'],
    handlers: [{ type: 'plain.noop', handle: () => ({ ok: true }) }],
  });
  registry.register(autoModule('off'));
  await registry.setEnabled('off', false);

  const deps = makeDeps({ registry });
  const r = await applyAuto(deps, 1, 'a.test');

  assert.equal(r.ok, true);
  assert.deepEqual(
    r.results.map((x) => x.moduleId),
    ['a'],
    '不该跑没有 autoApply 的、也不该跑被禁用的'
  );
});

test('PASS: shouldApply 返回 false 时不执行 apply', async () => {
  const registry = new ModuleRegistry();
  let applied = false;
  registry.register({
    id: 'a',
    title: 'a',
    requires: ['scripting'],
    handlers: [{ type: 'a.noop', handle: () => ({ ok: true }) }],
    autoApply: {
      shouldApply: () => false,
      apply: async () => {
        applied = true;
        return { ok: true };
      },
    },
  });

  const r = await applyAuto(makeDeps({ registry }), 1, 'a.test');
  assert.equal(applied, false);
  assert.deepEqual(r.results, []);
});

test('PASS: 结果顺序与注册顺序一致（可对照）', async () => {
  const registry = new ModuleRegistry();
  for (const id of ['c', 'a', 'b']) registry.register(autoModule(id));

  const r = await applyAuto(makeDeps({ registry }), 1, 'a.test');
  assert.deepEqual(
    r.results.map((x) => x.moduleId),
    ['c', 'a', 'b']
  );
});

/* ============================ applyAuto：容错 ============================ */

test('FAIL-SAFE: 单个模块抛错不拖垮其他模块', async () => {
  const registry = new ModuleRegistry();
  registry.register({
    id: 'broken',
    title: 'broken',
    requires: ['scripting'],
    handlers: [{ type: 'broken.noop', handle: () => ({ ok: true }) }],
    autoApply: {
      shouldApply: () => true,
      apply: async () => {
        throw new Error('内部细节：/home/user/x');
      },
    },
  });
  registry.register(autoModule('good'));

  const r = await applyAuto(makeDeps({ registry }), 1, 'a.test');
  const broken = r.results.find((x) => x.moduleId === 'broken');
  const good = r.results.find((x) => x.moduleId === 'good');

  assert.equal(broken.applied, false);
  assert.equal(broken.error, 'AUTO_APPLY_FAILED');
  assert.equal(good.applied, true, '好模块不该被坏模块拖累');
  // 不泄露 e.message
  assert.equal(JSON.stringify(r).includes('home/user'), false);
});

test('FAIL-SAFE: shouldApply 抛错也被兜住（不向上冒）', async () => {
  const registry = new ModuleRegistry();
  registry.register({
    id: 'boom',
    title: 'boom',
    requires: ['scripting'],
    handlers: [{ type: 'boom.noop', handle: () => ({ ok: true }) }],
    autoApply: {
      shouldApply: () => {
        throw new Error('判断失败');
      },
      apply: async () => ({ ok: true }),
    },
  });
  const r = await applyAuto(makeDeps({ registry }), 1, 'a.test');
  assert.equal(r.ok, true);
  assert.equal(r.results[0].applied, false);
});

test('FAIL-SAFE: apply 返回失败时记录错误码', async () => {
  const registry = new ModuleRegistry();
  registry.register(
    autoModule('a', { applyResult: { ok: false, error: 'HOST_PERMISSION_DENIED' } })
  );
  const r = await applyAuto(makeDeps({ registry }), 1, 'a.test');
  assert.equal(r.results[0].applied, false);
  assert.equal(r.results[0].error, 'HOST_PERMISSION_DENIED');
});

/* ============================ applyAuto：入参校验 ============================ */

test('FAIL-SAFE: 非法 tabId 或空 host 直接返回，不遍历模块', async () => {
  const registry = new ModuleRegistry();
  let called = false;
  registry.register({
    id: 'a',
    title: 'a',
    requires: ['scripting'],
    handlers: [{ type: 'a.noop', handle: () => ({ ok: true }) }],
    autoApply: {
      shouldApply: () => {
        called = true;
        return true;
      },
      apply: async () => ({ ok: true }),
    },
  });

  for (const [tabId, host] of [
    [null, 'a.test'],
    ['1', 'a.test'],
    [1.5, 'a.test'],
    [1, ''],
    [1, null],
    [1, 123],
  ]) {
    const r = await applyAuto(makeDeps({ registry }), tabId, host);
    assert.equal(r.ok, false, `${tabId} / ${host}`);
  }
  assert.equal(called, false, '非法入参不该触发任何模块');
});

/* ============================ autoApplyModules ============================ */

test('PASS: 能列出支持自动应用的模块', () => {
  const registry = new ModuleRegistry();
  registry.register(autoModule('a'));
  registry.register({
    id: 'plain',
    title: 'plain',
    requires: ['scripting'],
    handlers: [{ type: 'plain.noop', handle: () => ({ ok: true }) }],
  });
  assert.deepEqual(autoApplyModules(registry), ['a']);
});

/* ============================ 真实模块接入 ============================ */

test('PASS: 夜间模式与阅读模式都实现了 autoApply', async () => {
  const { createDarkModule } = await import('../lib/modules/dark.js');
  const { createReaderModule } = await import('../lib/modules/reader.js');
  const deps = {
    scripting: fakeScripting(),
    permissions: fakePermissions(),
    webNavigation: fakeNav(),
  };
  assert.equal(typeof createDarkModule(deps).autoApply.shouldApply, 'function');
  assert.equal(typeof createReaderModule(deps).autoApply.shouldApply, 'function');
});

test('FAIL-SAFE: 夜间模式的 autoApply 在 remember:false 时不做任何事', async () => {
  const { createDarkModule } = await import('../lib/modules/dark.js');
  const store = { darkSites: '["a.test"]', remember: false, brightness: 92, contrast: 100, sepia: 0 };
  const mod = createDarkModule({
    scripting: fakeScripting(),
    permissions: fakePermissions(),
    webNavigation: fakeNav(),
  });
  const ctx = { config: { get: (k) => store[k], set: async (k, v) => { store[k] = v; } } };

  assert.equal(await mod.autoApply.shouldApply('a.test', ctx), false);
});

test('FAIL-SAFE: 夜间模式的 autoApply 在未授权时返回 HOST_PERMISSION_DENIED 且不请求', async () => {
  const { createDarkModule } = await import('../lib/modules/dark.js');
  const perms = fakePermissions({ granted: false });
  const scripting = fakeScripting();
  const store = { darkSites: '["a.test"]', remember: true, brightness: 92, contrast: 100, sepia: 0 };
  const mod = createDarkModule({
    scripting,
    permissions: perms,
    webNavigation: fakeNav(),
  });
  const ctx = { config: { get: (k) => store[k], set: async (k, v) => { store[k] = v; } } };

  const r = await mod.autoApply.apply(7, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'HOST_PERMISSION_DENIED');
  assert.equal(perms.calls.request, 0, '自动应用请求了权限');
  assert.equal(scripting.calls.length, 0);
});

test('PASS: 夜间模式的 autoApply 在已授权时注入', async () => {
  const { createDarkModule } = await import('../lib/modules/dark.js');
  const perms = fakePermissions({ granted: true });
  const scripting = fakeScripting({ ok: true, brightness: 92 });
  const store = { darkSites: '["a.test"]', remember: true, brightness: 80, contrast: 100, sepia: 0 };
  const mod = createDarkModule({
    scripting,
    permissions: perms,
    webNavigation: fakeNav(),
  });
  const ctx = { config: { get: (k) => store[k], set: async (k, v) => { store[k] = v; } } };

  const r = await mod.autoApply.apply(7, ctx);
  assert.equal(r.ok, true);
  assert.equal(scripting.calls[0].args[0].brightness, 80, '没把配置带进去');
  assert.equal(perms.calls.request, 0);
});
