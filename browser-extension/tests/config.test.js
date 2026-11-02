// 配置中心的自动化测试。
//
// 核心断言：**schema 就是边界**——未声明的键读不到、非法值写不进、
// 带 secret 的 schema 根本注册不进来。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigCenter,
  ConfigError,
  MemoryStore,
  defineSchema,
  validateValue,
} from '../lib/config.js';

function centerWith(spec) {
  const c = new ConfigCenter();
  const view = c.registerModule('demo', spec);
  return { c, view };
}

/* --------------------------- schema 校验 --------------------------- */

test('PASS: 合法 schema 被冻结', () => {
  const s = defineSchema({
    a: { type: 'boolean', default: true },
    b: { type: 'number', default: 3, min: 1, max: 5, integer: true },
    c: { type: 'string', default: 'x', maxLength: 8 },
    d: { type: 'enum', values: ['p', 'q'], default: 'p' },
  });
  assert.equal(Object.isFrozen(s), true);
  assert.equal(Object.isFrozen(s.a), true);
  // 冻结后改不动（非严格模式下静默失败，严格模式下抛错）
  assert.throws(() => {
    'use strict';
    s.a.default = false;
  });
});

test('FAIL-SAFE: secret:true 的 schema 直接拒绝注册', () => {
  // 这是硬规则：密码/密钥/令牌永远不得进配置
  const c = new ConfigCenter();
  for (const key of ['password', 'masterPassword', 'token', 'apiKey']) {
    assert.throws(
      () => c.registerModule('x', { [key]: { type: 'string', default: '', secret: true } }),
      (e) => e instanceof ConfigError && e.code === 'SECRET_FORBIDDEN',
      key
    );
  }
});

test('FAIL-SAFE: 各种坏 schema 都被拒绝', () => {
  const bad = [
    [{ k: { type: 'boolean' } }, 'BAD_SCHEMA'], // 缺 default
    [{ k: { type: 'boolean', default: 'yes' } }, 'BAD_SCHEMA'],
    [{ k: { type: 'number', default: 5, min: 10 } }, 'BAD_SCHEMA'], // 默认值越界
    [{ k: { type: 'number', default: 1.5, integer: true } }, 'BAD_SCHEMA'],
    [{ k: { type: 'enum', values: [], default: 'a' } }, 'BAD_SCHEMA'],
    [{ k: { type: 'enum', values: ['a'], default: 'b' } }, 'BAD_SCHEMA'],
    [{ k: { type: 'whatever', default: 1 } }, 'BAD_SCHEMA'],
    [{ 'bad key': { type: 'boolean', default: true } }, 'BAD_KEY'],
    [{ 'k.x': { type: 'boolean', default: true } }, 'BAD_KEY'],
    [{ k: null }, 'BAD_SCHEMA'],
  ];
  for (const [spec, code] of bad) {
    const c = new ConfigCenter();
    assert.throws(
      () => c.registerModule('x', spec),
      (e) => e instanceof ConfigError && e.code === code,
      JSON.stringify(spec)
    );
  }
});

test('FAIL-SAFE: 非法模块 id 被拒绝', () => {
  const c = new ConfigCenter();
  for (const id of ['', 'X', 'a b', '1a', 'a_b', 'a/b']) {
    assert.throws(
      () => c.registerModule(id, {}),
      (e) => e.code === 'BAD_MODULE_ID',
      id
    );
  }
});

test('FAIL-SAFE: 重复注册模块被拒绝', () => {
  const c = new ConfigCenter();
  c.registerModule('a', {});
  assert.throws(
    () => c.registerModule('a', {}),
    (e) => e.code === 'DUPLICATE_MODULE'
  );
});

/* --------------------------- 读写 --------------------------- */

test('PASS: 未设置的键返回 schema 默认值', () => {
  const { view } = centerWith({
    enabled: { type: 'boolean', default: false },
    n: { type: 'number', default: 7 },
  });
  assert.equal(view.get('enabled'), false);
  assert.equal(view.get('n'), 7);
  assert.deepEqual({ ...view.all() }, { enabled: false, n: 7 });
});

test('PASS: 写入后读到新值', async () => {
  const { view } = centerWith({ n: { type: 'number', default: 1, min: 0, max: 10 } });
  await view.set('n', 9);
  assert.equal(view.get('n'), 9);
});

test('FAIL-SAFE: 非法值不会写入（不留半截状态）', async () => {
  const { view } = centerWith({ n: { type: 'number', default: 3, min: 0, max: 10 } });
  // 注意 1.5 不在这里：这个 schema 没声明 integer，1.5 是合法值（见下一条测试）
  for (const bad of [11, -1, '5', null, undefined, NaN, Infinity]) {
    await assert.rejects(
      () => view.set('n', bad),
      (e) => e instanceof ConfigError,
      String(bad)
    );
    // 拒绝后仍是原值
    assert.equal(view.get('n'), 3, `值被污染: ${String(bad)}`);
  }
});

test('PASS: 未声明 integer 时接受小数', async () => {
  const { view } = centerWith({ n: { type: 'number', default: 3, min: 0, max: 10 } });
  await view.set('n', 1.5);
  assert.equal(view.get('n'), 1.5);
});

test('FAIL-SAFE: 整数约束生效', async () => {
  const { view } = centerWith({
    px: { type: 'number', default: 2, min: 1, max: 8, integer: true },
  });
  await assert.rejects(() => view.set('px', 2.5), (e) => e.code === 'BAD_TYPE');
  await view.set('px', 4);
  assert.equal(view.get('px'), 4);
});

test('FAIL-SAFE: 字符串长度上限生效', async () => {
  const { view } = centerWith({ s: { type: 'string', default: '', maxLength: 5 } });
  await assert.rejects(() => view.set('s', 'abcdef'), (e) => e.code === 'OUT_OF_RANGE');
  await view.set('s', 'abcde');
  assert.equal(view.get('s'), 'abcde');
});

test('PASS: 枚举只接受白名单内的值', async () => {
  const { view } = centerWith({
    mode: { type: 'enum', values: ['off', 'basic', 'strict'], default: 'basic' },
  });
  await view.set('mode', 'strict');
  assert.equal(view.get('mode'), 'strict');
  await assert.rejects(() => view.set('mode', 'paranoid'), (e) => e.code === 'BAD_VALUE');
});

test('FAIL-SAFE: 未声明的键读写都抛错', async () => {
  const { view } = centerWith({ a: { type: 'boolean', default: true } });
  assert.throws(() => view.get('b'), (e) => e.code === 'UNKNOWN_KEY');
  await assert.rejects(() => view.set('b', 1), (e) => e.code === 'UNKNOWN_KEY');
});

test('FAIL-SAFE: 未注册的模块访问抛错', () => {
  const c = new ConfigCenter();
  assert.throws(() => c.get('ghost', 'a'), (e) => e.code === 'UNKNOWN_MODULE');
});

test('PASS: reset 回到默认值', async () => {
  const { view } = centerWith({ n: { type: 'number', default: 1 } });
  await view.set('n', 5);
  await view.reset();
  assert.equal(view.get('n'), 1);
});

/* --------------------------- 持久化 --------------------------- */

test('PASS: 写入会同步到后端，load 能读回来', async () => {
  const store = new MemoryStore();
  const a = new ConfigCenter({ store });
  a.registerModule('m', { n: { type: 'number', default: 1, max: 100 } });
  await a.set('m', 'n', 42);

  const b = new ConfigCenter({ store });
  b.registerModule('m', { n: { type: 'number', default: 1, max: 100 } });
  const r = await b.load('m');
  assert.deepEqual(r.dropped, []);
  assert.equal(b.get('m', 'n'), 42);
});

test('FAIL-SAFE: 后端里的脏数据被丢弃，模块仍能起来', async () => {
  // 场景：旧版本写了不存在的键、或手改坏了存储
  const store = new MemoryStore({
    'keynest.cfg.m': { n: 999, ghost: 'x', another: true },
  });
  const c = new ConfigCenter({ store });
  c.registerModule('m', { n: { type: 'number', default: 1, max: 100 } });
  const r = await c.load('m');
  assert.equal(c.get('m', 'n'), 1, '越界值被丢弃，回到默认');
  assert.deepEqual(r.dropped.sort(), ['another', 'ghost', 'n'].sort());
});

test('PASS: load 时后端为空不影响默认值', async () => {
  const c = new ConfigCenter();
  c.registerModule('m', { n: { type: 'number', default: 9 } });
  const r = await c.load('m');
  assert.deepEqual(r.dropped, []);
  assert.equal(c.get('m', 'n'), 9);
});

/* --------------------------- 命名空间 --------------------------- */

test('PASS: 两个模块同名键互不影响', async () => {
  const c = new ConfigCenter();
  const a = c.registerModule('a', { enabled: { type: 'boolean', default: true } });
  const b = c.registerModule('b', { enabled: { type: 'boolean', default: true } });
  await a.set('enabled', false);
  assert.equal(a.get('enabled'), false);
  assert.equal(b.get('enabled'), true, '命名空间串了');
});

test('PASS: 后端键名带命名空间前缀', async () => {
  const store = new MemoryStore();
  const c = new ConfigCenter({ store });
  const view = c.registerModule('reader', { enabled: { type: 'boolean', default: true } });
  await view.set('enabled', false);
  assert.equal(store.map.has('keynest.cfg.reader'), true);
  assert.equal(store.map.has('enabled'), false);
});

/* --------------------------- 值校验纯函数 --------------------------- */

test('PASS: validateValue 单独可用', () => {
  const schema = defineSchema({ n: { type: 'number', default: 1, min: 0, max: 5 } });
  assert.equal(validateValue(schema, 'n', 3), 3);
  assert.throws(() => validateValue(schema, 'n', 6), (e) => e.code === 'OUT_OF_RANGE');
});
