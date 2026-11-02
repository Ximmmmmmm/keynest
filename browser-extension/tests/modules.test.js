// 模块注册表与权限清单的自动化测试。
//
// 核心断言：
//   1. 模块声明在注册时就被校验完，不留到运行时
//   2. 消息类型与模块 id 都唯一，冲突不覆盖
//   3. handler 抛错不会冒到 SW 顶层
//   4. 权限清单能从模块反推出来，且能发现 manifest 的缺失与冗余

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModuleRegistry, ModuleError } from '../lib/modules.js';
import { KeyNestError } from '../lib/errors.js';
import {
  CAPABILITIES,
  PermissionError,
  assertCapability,
  diffManifest,
  requiredManifestPermissions,
  validateRequires,
} from '../lib/permissions.js';

function ok(spec) {
  return {
    id: 'demo',
    title: '演示',
    requires: ['contentScript'],
    ...spec,
  };
}

/* --------------------------- 注册校验 --------------------------- */

test('PASS: 最小模块可以注册，并自动获得 enabled', () => {
  const r = new ModuleRegistry();
  r.register(ok());
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'demo');
  assert.equal(list[0].enabled, true, '未声明 defaultEnabled 时默认启用');
  assert.equal(list[0].config.enabled, true);
});

test('PASS: defaultEnabled:false 的模块默认关闭', () => {
  const r = new ModuleRegistry();
  r.register(ok({ id: 'exp', defaultEnabled: false }));
  assert.equal(r.isEnabled('exp'), false);
});

test('PASS: 模块自带配置与自动注入的 enabled 合并', () => {
  const r = new ModuleRegistry();
  r.register(ok({ config: { mode: { type: 'enum', values: ['a', 'b'], default: 'a' } } }));
  const cfg = r.list()[0].config;
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.mode, 'a');
});

test('FAIL-SAFE: 非法模块定义被拒绝', () => {
  const bad = [
    [null, 'BAD_SPEC'],
    [{}, 'BAD_ID'],
    [{ id: 'Demo', title: 'x' }, 'BAD_ID'],
    [{ id: 'demo' }, 'BAD_TITLE'],
    [ok({ requires: 'contentScript' }), 'BAD_REQUIRES'],
    [ok({ requires: ['nonexistent'] }), 'UNKNOWN_CAPABILITY'],
    [ok({ requires: ['contentScript', 'contentScript'] }), 'DUPLICATE_CAPABILITY'],
    [ok({ handlers: 'x' }), 'BAD_HANDLERS'],
    [ok({ handlers: [{ type: 'a.b' }] }), 'BAD_HANDLER'],
    [ok({ handlers: [{ type: 'BAD TYPE', handle: () => ({}) }] }), 'BAD_MESSAGE_TYPE'],
  ];
  for (const [spec, code] of bad) {
    const r = new ModuleRegistry();
    assert.throws(
      () => r.register(spec),
      (e) => e instanceof KeyNestError && e.code === code,
      `${JSON.stringify(spec)} → ${code}`
    );
  }
});

test('FAIL-SAFE: 模块重复注册被拒绝', () => {
  const r = new ModuleRegistry();
  r.register(ok());
  assert.throws(() => r.register(ok()), (e) => e.code === 'DUPLICATE_MODULE');
});

test('FAIL-SAFE: 消息类型冲突被拒绝，且不覆盖已有模块', () => {
  const r = new ModuleRegistry();
  r.register(ok({ id: 'a', handlers: [{ type: 'shared.x', handle: () => ({ who: 'a' }) }] }));
  assert.throws(
    () => r.register(ok({ id: 'b', handlers: [{ type: 'shared.x', handle: () => ({ who: 'b' }) }] })),
    (e) => e.code === 'DUPLICATE_MESSAGE'
  );
  // 模块 b 没有半截注册
  assert.equal(r.list().length, 1);
});

test('PASS: 同一模块内重复消息类型被拒绝', () => {
  const r = new ModuleRegistry();
  assert.throws(
    () =>
      r.register(
        ok({
          handlers: [
            { type: 'a.b', handle: () => ({}) },
            { type: 'a.b', handle: () => ({}) },
          ],
        })
      ),
    (e) => e.code === 'DUPLICATE_HANDLER'
  );
});

/* --------------------------- 分派 --------------------------- */

test('PASS: 分派到正确的 handler，且原样返回它的响应体', async () => {
  const r = new ModuleRegistry();
  r.register(
    ok({ handlers: [{ type: 'demo.ping', handle: () => ({ ok: true, pong: 1 }) }] })
  );
  const res = await r.dispatch('demo.ping', {}, {});
  assert.deepEqual(res, { ok: true, pong: 1 });
});

test('PASS: 支持不带点的旧消息名（线上协议不变）', async () => {
  const r = new ModuleRegistry();
  r.register(ok({ handlers: [{ type: 'status', handle: () => ({ ok: true, legacy: true }) }] }));
  const res = await r.dispatch('status', {}, {});
  assert.deepEqual(res, { ok: true, legacy: true });
});

test('FAIL-SAFE: 未知消息类型明确返回 UNKNOWN_TYPE', async () => {
  const r = new ModuleRegistry();
  r.register(ok());
  const res = await r.dispatch('nope.x', {}, {});
  assert.deepEqual(res, { ok: false, error: 'UNKNOWN_TYPE' });
});

test('FAIL-SAFE: 模块被禁用时 handler 不执行', async () => {
  let called = 0;
  const r = new ModuleRegistry();
  r.register(
    ok({
      id: 'exp',
      handlers: [
        { type: 'exp.run', handle: () => { called += 1; return { ok: true }; } },
      ],
    })
  );
  await r.setEnabled('exp', false);
  const res = await r.dispatch('exp.run', {}, {});
  assert.deepEqual(res, { ok: false, error: 'MODULE_DISABLED' });
  assert.equal(called, 0, '被禁用的模块不该执行 handler');
});

test('FAIL-SAFE: handler 抛错不冒泡，只回错误码', async () => {
  const r = new ModuleRegistry();
  r.register(
    ok({
      handlers: [
        {
          type: 'demo.boom',
          handle: () => {
            const e = new Error('内部细节：/home/user/secret.txt');
            e.code = 'DISK_FULL';
            throw e;
          },
        },
        {
          type: 'demo.plain',
          handle: () => {
            throw new Error('没有 code 的异常');
          },
        },
      ],
    })
  );

  const a = await r.dispatch('demo.boom', {}, {});
  assert.deepEqual(a, { ok: false, error: 'DISK_FULL' }, '不该把 e.message 带出来');

  const b = await r.dispatch('demo.plain', {}, {});
  assert.deepEqual(b, { ok: false, error: 'HANDLER_FAILED' });
});

test('PASS: 异步 handler 被正确等待', async () => {
  const r = new ModuleRegistry();
  r.register(
    ok({
      handlers: [
        {
          type: 'demo.slow',
          handle: async () => {
            await new Promise((res) => setTimeout(res, 5));
            return { ok: true, done: true };
          },
        },
      ],
    })
  );
  assert.deepEqual(await r.dispatch('demo.slow', {}, {}), { ok: true, done: true });
});

test('PASS: dispatch 把 ctx（含 config 视图）传给 handler', async () => {
  const r = new ModuleRegistry();
  let seen = null;
  r.register(
    ok({
      config: { limit: { type: 'number', default: 7 } },
      handlers: [
        {
          type: 'demo.ctx',
          handle: (msg, ctx) => {
            seen = { msg, moduleId: ctx.moduleId, limit: ctx.config.get('limit'), kind: ctx.kind };
            return { ok: true };
          },
        },
      ],
    })
  );
  await r.dispatch('demo.ctx', { x: 1 }, { kind: 'popup' });
  assert.deepEqual(seen, { msg: { x: 1 }, moduleId: 'demo', limit: 7, kind: 'popup' });
});

/* --------------------------- 权限清单 --------------------------- */

test('PASS: 能力映射到 manifest 权限名', () => {
  assert.equal(CAPABILITIES.nativeMessaging, 'nativeMessaging');
  assert.equal(CAPABILITIES.contentScript, null, '纯内容脚本不需要额外 manifest 权限');
  assert.equal(CAPABILITIES.hostHttps, 'host:https');
});

test('PASS: 从多个模块求和 manifest 权限（去重 + 稳定排序）', () => {
  const need = requiredManifestPermissions([
    { id: 'a', requires: ['nativeMessaging', 'scripting'] },
    { id: 'b', requires: ['scripting', 'hostHttps'] },
    { id: 'c', requires: ['declarativeNetRequest'] },
  ]);
  assert.deepEqual(need.permissions, ['declarativeNetRequest', 'nativeMessaging', 'scripting']);
  assert.deepEqual(need.hostPermissions, ['https://*/*']);
});

test('PASS: 纯内部能力不产生 manifest 权限', () => {
  const need = requiredManifestPermissions([
    { id: 'a', requires: ['contentScript', 'extensionPages'] },
  ]);
  assert.deepEqual(need.permissions, []);
  assert.deepEqual(need.hostPermissions, []);
});

test('FAIL-SAFE: 未知能力进入 unknownCapabilities 而非静默忽略', () => {
  const need = requiredManifestPermissions([{ id: 'a', requires: ['telepathy'] }]);
  assert.deepEqual(need.unknownCapabilities, ['telepathy']);
  assert.deepEqual(need.permissions, []);
});

test('PASS: diffManifest 能同时发现缺失与冗余', () => {
  const modules = [{ id: 'vault', requires: ['nativeMessaging', 'webNavigation'] }];
  const manifest = {
    permissions: ['nativeMessaging', 'webNavigation', 'tabs', 'storage'],
    host_permissions: [],
  };
  const d = diffManifest(manifest, modules);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.unused, ['storage', 'tabs'], '声明了但没人用 → 权限膨胀');
  assert.equal(d.ok, false);
});

test('FAIL-SAFE: diffManifest 报出模块需要但 manifest 没声明的权限', () => {
  const modules = [{ id: 'adblock', requires: ['declarativeNetRequest'] }];
  const d = diffManifest({ permissions: [] }, modules);
  assert.deepEqual(d.missing, ['declarativeNetRequest']);
  assert.equal(d.ok, false);
});

test('PASS: 完全一致时 ok 为 true', () => {
  const modules = [{ id: 'vault', requires: ['nativeMessaging'] }];
  const d = diffManifest({ permissions: ['nativeMessaging'] }, modules);
  assert.equal(d.ok, true);
});

test('PASS: host 权限缺失被单独报出', () => {
  const modules = [{ id: 'vault', requires: ['hostHttps'] }];
  const d = diffManifest({ permissions: [], host_permissions: [] }, modules);
  assert.deepEqual(d.missingHosts, ['https://*/*']);
  assert.equal(d.ok, false);
});

test('FAIL-SAFE: validateRequires 拒绝未知能力与重复', () => {
  assert.throws(() => validateRequires('m', ['nope']), (e) => e instanceof PermissionError && e.code === 'UNKNOWN_CAPABILITY');
  assert.throws(() => validateRequires('m', ['scripting', 'scripting']), (e) => e.code === 'DUPLICATE_CAPABILITY');
  assert.throws(() => validateRequires('m', 'scripting'), (e) => e.code === 'BAD_REQUIRES');
});

test('FAIL-SAFE: assertCapability 拦住未声明的能力', () => {
  assert.doesNotThrow(() => assertCapability('m', 'scripting', ['scripting']));
  assert.throws(
    () => assertCapability('m', 'tabs', ['scripting']),
    (e) => e.code === 'UNDECLARED_CAPABILITY'
  );
  assert.throws(
    () => assertCapability('m', 'telepathy', ['scripting']),
    (e) => e.code === 'UNKNOWN_CAPABILITY'
  );
});

test('PASS: registry 能从自己的模块反推权限', () => {
  const r = new ModuleRegistry();
  r.register(ok({ id: 'vault', requires: ['nativeMessaging', 'webNavigation'] }));
  const need = r.requiredManifestPermissions();
  assert.deepEqual(need.permissions, ['nativeMessaging', 'webNavigation']);
});

test('PASS: capabilityOwners 能查出谁在用某个能力', () => {
  const r = new ModuleRegistry();
  r.register(ok({ id: 'a', requires: ['scripting'] }));
  r.register(ok({ id: 'b', requires: ['scripting', 'tabs'] }));
  assert.deepEqual(r.capabilityOwners('scripting'), ['a', 'b']);
  assert.deepEqual(r.capabilityOwners('tabs'), ['b']);
  assert.deepEqual(r.capabilityOwners('notifications'), []);
});
