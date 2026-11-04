// 持久化后端与存储审计的测试。
//
// # 这个文件最关心的事
//
// 打开 `storage` 权限等于打开一个口子。所以测的重点不是"能存能读"，
// 而是**存了什么、不能存什么、存不下时怎么办**。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigCenter } from '../lib/config.js';
import {
  STORAGE_PREFIX,
  ChromeStorageStore,
  inspectStorage,
  pickStore,
  scanForSensitiveKeys,
} from '../lib/storage.js';

/** 假 chrome.storage.local：行为贴近真实（get(null) 返回全部）。 */
function fakeArea(opts = {}) {
  const data = new Map(Object.entries(opts.initial || {}));
  return {
    data,
    async get(key) {
      if (opts.failGet) throw new Error('storage unavailable');
      if (key === null || key === undefined) {
        const out = {};
        for (const [k, v] of data) out[k] = v;
        return out;
      }
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (data.has(k)) out[k] = data.get(k);
        return out;
      }
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(obj) {
      if (opts.failSet) throw new Error('quota exceeded');
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    async remove(key) {
      if (opts.failRemove) throw new Error('nope');
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
    },
  };
}

/* ============================ 后端行为 ============================ */

test('PASS: 写入后可读回，键名带统一前缀', async () => {
  const area = fakeArea();
  const store = new ChromeStorageStore(area);
  await store.write('cfg.adblock', { mode: 'strict' });
  assert.equal(area.data.has(`${STORAGE_PREFIX}cfg.adblock`), true);
  assert.deepEqual(await store.read('cfg.adblock'), { mode: 'strict' });
});

test('FAIL-SAFE: 读不存在的键返回 null 而不是抛错', async () => {
  const store = new ChromeStorageStore(fakeArea());
  assert.equal(await store.read('cfg.ghost'), null);
});

test('FAIL-SAFE: 存储里的脏值（数组/字符串）被当成不存在', async () => {
  const area = fakeArea({ initial: { [`${STORAGE_PREFIX}cfg.x`]: 'not-an-object' } });
  const store = new ChromeStorageStore(area);
  assert.equal(await store.read('cfg.x'), null, '字符串不该被当成配置对象');

  area.data.set(`${STORAGE_PREFIX}cfg.y`, [1, 2, 3]);
  assert.equal(await store.read('cfg.y'), null, '数组同理');
});

test('PASS: 删除键', async () => {
  const area = fakeArea();
  const store = new ChromeStorageStore(area);
  await store.write('cfg.a', { v: 1 });
  await store.delete('cfg.a');
  assert.equal(await store.read('cfg.a'), null);
});

test('PASS: listKeys 只列本扩展前缀下的键', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}cfg.a`]: {},
      [`${STORAGE_PREFIX}cfg.b`]: {},
      'someone-else.key': {},
    },
  });
  const store = new ChromeStorageStore(area);
  assert.deepEqual(await store.listKeys(), ['cfg.a', 'cfg.b']);
});

test('PASS: clearAll 只清本扩展的键，不动别人的', async () => {
  const area = fakeArea({
    initial: { [`${STORAGE_PREFIX}cfg.a`]: {}, 'other.key': {} },
  });
  const store = new ChromeStorageStore(area);
  const n = await store.clearAll();
  assert.equal(n, 1);
  assert.equal(area.data.has('other.key'), true, '不该清掉别的前缀的键');
});

/* ============================ 后端选择 ============================ */

test('FAIL-SAFE: 没有 storage 权限时退回内存，并说明原因', async () => {
  const r = await pickStore({});
  assert.equal(r.persistent, false);
  assert.equal(r.reason, 'NO_STORAGE_PERMISSION');
  // 内存后端仍可用
  await r.store.write('x', { a: 1 });
  assert.deepEqual(await r.store.read('x'), { a: 1 });
});

test('FAIL-SAFE: API 存在但调用抛错时退回内存', async () => {
  const r = await pickStore({ storage: { local: fakeArea({ failSet: true }) } });
  assert.equal(r.persistent, false);
  assert.equal(r.reason, 'PROBE_FAILED');
});

test('PASS: 可用时返回持久后端', async () => {
  const r = await pickStore({ storage: { local: fakeArea() } });
  assert.equal(r.persistent, true);
  assert.equal(r.reason, 'OK');
});

test('FAIL-SAFE: 探测用的临时键会被清掉（不留垃圾）', async () => {
  const area = fakeArea();
  await pickStore({ storage: { local: area } });
  const keys = [...area.data.keys()];
  assert.deepEqual(keys, [], `探测后残留了键: ${keys.join(',')}`);
});

test('FAIL-SAFE: 探测是"真写一次"，不只看 API 是否存在', async () => {
  // 某些环境里 API 存在但写进去读出来不是同一个值（策略拦截）
  const area = fakeArea();
  const originalGet = area.get;
  area.get = async (key) => {
    const out = await originalGet(key);
    // 模拟写入被静默丢弃
    return key === null ? out : {};
  };
  const r = await pickStore({ storage: { local: area } });
  assert.equal(r.persistent, false);
  assert.equal(r.reason, 'PROBE_MISMATCH');
});

/* ============================ 与配置中心集成 ============================ */

test('PASS: 配置经持久后端后能被新实例读回（模拟 SW 重启）', async () => {
  const area = fakeArea();
  const store = new ChromeStorageStore(area);

  const a = new ConfigCenter({ store });
  a.registerModule('adblock', {
    mode: { type: 'enum', values: ['off', 'basic', 'strict'], default: 'basic' },
  });
  await a.set('adblock', 'mode', 'strict');

  // 新实例 = SW 重启后的新执行环境
  const b = new ConfigCenter({ store });
  b.registerModule('adblock', {
    mode: { type: 'enum', values: ['off', 'basic', 'strict'], default: 'basic' },
  });
  await b.load('adblock');
  assert.equal(b.get('adblock', 'mode'), 'strict', '重启后设置丢了');
});

test('FAIL-SAFE: 持久层里的越界值在载入时被丢弃（不信任存储）', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}cfg.m`]: { n: 9999, junk: 'x' },
    },
  });
  const c = new ConfigCenter({ store: new ChromeStorageStore(area) });
  c.registerModule('m', { n: { type: 'number', default: 1, max: 100 } });
  const r = await c.load('m');
  assert.equal(c.get('m', 'n'), 1, '越界值被丢弃，回到默认');
  assert.deepEqual(r.dropped.sort(), ['junk', 'n'].sort());
});

test('FAIL-SAFE: 存储里塞进来的 secret 键不会被读入（schema 里没有就是没有）', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}cfg.m`]: { password: 'hunter2', token: 'abc' },
    },
  });
  const c = new ConfigCenter({ store: new ChromeStorageStore(area) });
  const view = c.registerModule('m', { enabled: { type: 'boolean', default: true } });
  const r = await c.load('m');
  assert.deepEqual(r.dropped.sort(), ['password', 'token']);
  assert.equal('password' in view.all(), false);
});

/* ============================ 审计 ============================ */

test('PASS: inspectStorage 列出命名空间但**不返回值**', async () => {
  const area = fakeArea();
  const store = new ChromeStorageStore(area);
  await store.write('cfg.adblock', { mode: 'strict', allow: ['a.test'] });

  const info = await inspectStorage(store);
  assert.equal(info.persistent, true);
  assert.deepEqual(info.namespaces, ['adblock']);
  // 结果里不该有任何配置值
  const json = JSON.stringify(info);
  assert.equal(json.includes('strict'), false, '审计结果不该泄露配置值');
  assert.equal(json.includes('a.test'), false);
});

test('FAIL-SAFE: 内存后端时 inspectStorage 明确报告不持久', async () => {
  const r = await pickStore({});
  const info = await inspectStorage(r.store);
  assert.equal(info.persistent, false);
  assert.deepEqual(info.namespaces, []);
});

test('FAIL-SAFE: scanForSensitiveKeys 能发现绕过配置中心写入的敏感数据', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}cfg.ok`]: { enabled: true },
      [`${STORAGE_PREFIX}rogue`]: { password: 'hunter2', apiKey: 'sk-xxx' },
      [`${STORAGE_PREFIX}pathed`]: { 'bridge.key': 'xxx' },
    },
  });
  const r = await scanForSensitiveKeys(area);
  assert.equal(r.total, 3);
  assert.ok(r.hits.some((h) => h.includes('password')));
  assert.ok(r.hits.some((h) => h.includes('apiKey')));
  assert.ok(r.hits.some((h) => h.includes('bridge.key')));
});

test('PASS: 干净存储扫描无命中', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}cfg.adblock`]: { enabled: true, mode: 'strict' },
      [`${STORAGE_PREFIX}cfg.vault`]: { enabled: true },
    },
  });
  const r = await scanForSensitiveKeys(area);
  assert.deepEqual(r.hits, []);
  assert.equal(r.total, 2);
});

test('FAIL-SAFE: 嵌套结构里的敏感键也能被发现', async () => {
  const area = fakeArea({
    initial: {
      [`${STORAGE_PREFIX}x`]: { a: { b: { secretToken: 'x' } } },
    },
  });
  const r = await scanForSensitiveKeys(area);
  assert.ok(r.hits.some((h) => h.includes('secretToken')));
});

/* ============================ 前缀约束 ============================ */

test('PASS: 前缀是稳定字符串（改它会让已存的设置全部失效）', () => {
  assert.equal(STORAGE_PREFIX, 'keynest.');
});

test('FAIL-SAFE: 自定义前缀也被尊重（测试隔离用）', async () => {
  const area = fakeArea();
  const store = new ChromeStorageStore(area, { prefix: 'test.' });
  await store.write('cfg.a', { v: 1 });
  assert.equal(area.data.has('test.cfg.a'), true);
  assert.equal(area.data.has('keynest.cfg.a'), false);
});
