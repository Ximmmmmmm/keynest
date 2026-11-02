// 按站点记忆的测试。
//
// 这个功能的失败模式是「开关自己跳」：用户开了夜间模式，翻页后没了；
// 或者某个从没开过的站点莫名其妙是开的。
//
// 所以重点在：名单与模块分开、子域归属、上限、注入失败不写名单。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SITE_LIST,
  SITE_SCOPED_MODULES,
  addSite,
  configKeyFor,
  createSiteMemory,
  hasSite,
  parseSites,
  removeSite,
  sanitizeSites,
} from '../lib/site-memory.js';

/** 带记忆的假配置视图。 */
function fakeConfig(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: (k) => store[k],
    set: async (k, v) => {
      store[k] = v;
    },
  };
}

/* ============================ 清洗 ============================ */

test('PASS: 清洗去重、保序、拒绝 URL', () => {
  const raw = ['b.test', 'a.test', 'b.test', 'https://x.test/', '', null, 'a.test:443'];
  assert.deepEqual(sanitizeSites(raw), ['b.test', 'a.test']);
});

test('FAIL-SAFE: 非数组得到空名单', () => {
  for (const bad of [null, undefined, 'a.test', 42, {}]) {
    assert.deepEqual(sanitizeSites(bad), [], String(bad));
  }
});

test('FAIL-SAFE: 超上限截断到 100，丢尾部', () => {
  const raw = Array.from({ length: MAX_SITE_LIST + 30 }, (_, i) => `s${i}.test`);
  const out = sanitizeSites(raw);
  assert.equal(out.length, MAX_SITE_LIST);
  assert.equal(out[0], 's0.test');
});

test('PASS: 上限比 allowlist 小（这是"常用站点"级别）', () => {
  assert.equal(MAX_SITE_LIST, 100);
});

test('FAIL-SAFE: 坏 JSON 当空名单', () => {
  for (const bad of ['{', 'null', '"x"', '', '123']) {
    assert.deepEqual(parseSites(bad), [], bad);
  }
});

/* ============================ 增删 ============================ */

test('PASS: 新加在最前，重复则提前', () => {
  assert.deepEqual(addSite([], 'a.test').list, ['a.test']);
  assert.deepEqual(addSite(['a.test'], 'b.test').list, ['b.test', 'a.test']);
  assert.deepEqual(addSite(['a.test', 'b.test'], 'b.test').list, ['b.test', 'a.test']);
});

test('PASS: 已在最前时返回同一引用（避免无意义写存储）', () => {
  const cur = ['a.test'];
  const r = addSite(cur, 'a.test');
  assert.equal(r.list, cur);
  assert.equal(r.added, false);
});

test('FAIL-SAFE: 非法域名不改变名单', () => {
  const cur = ['a.test'];
  assert.equal(addSite(cur, 'https://x.test/').list, cur);
  assert.equal(removeSite(cur, 'bad entry').removed, false);
});

test('PASS: 超上限丢最旧', () => {
  const cur = Array.from({ length: MAX_SITE_LIST }, (_, i) => `s${i}.test`);
  const { list } = addSite(cur, 'new.test');
  assert.equal(list.length, MAX_SITE_LIST);
  assert.equal(list[0], 'new.test');
  assert.equal(list.includes(`s${MAX_SITE_LIST - 1}.test`), false);
});

/* ============================ 归属匹配 ============================ */

test('PASS: 子域算命中', () => {
  assert.equal(hasSite(['example.test'], 'www.example.test'), true);
  assert.equal(hasSite(['example.test'], 'a.b.example.test'), true);
});

test('FAIL-SAFE: 相似域名不命中（标签边界）', () => {
  assert.equal(hasSite(['example.test'], 'notexample.test'), false);
  assert.equal(hasSite(['example.test'], 'example.test.evil.test'), false);
});

test('FAIL-SAFE: 大小写与尾点不能绕过', () => {
  assert.equal(hasSite(['example.test'], 'WWW.EXAMPLE.TEST.'), true);
});

/* ============================ 模块隔离 ============================ */

test('PASS: 已知模块的配置键', () => {
  assert.equal(configKeyFor('dark'), 'darkSites');
  assert.equal(configKeyFor('reader'), 'readerSites');
});

test('FAIL-SAFE: 未知模块抛错（而不是悄悄共用一个键）', () => {
  assert.throws(() => configKeyFor('adblock'), /不支持按站点记忆/);
  assert.throws(() => configKeyFor('nope'), /不支持按站点记忆/);
});

test('PASS: 允许列表是冻结的', () => {
  assert.equal(Object.isFrozen(SITE_SCOPED_MODULES), true);
  assert.deepEqual([...SITE_SCOPED_MODULES], ['dark', 'reader']);
});

test('FAIL-SAFE: 两个模块的名单互不影响', async () => {
  const cfg = fakeConfig({ darkSites: '[]', readerSites: '[]' });
  const dark = createSiteMemory(cfg, 'dark');
  const reader = createSiteMemory(cfg, 'reader');

  await dark.enable('a.test');

  assert.equal(dark.has('a.test'), true);
  assert.equal(reader.has('a.test'), false, '模块之间串了');

  await reader.enable('b.test');
  assert.deepEqual(dark.list(), ['a.test']);
  assert.deepEqual(reader.list(), ['b.test']);
});

/* ============================ 读写接口 ============================ */

test('PASS: enable / disable 往返', async () => {
  const cfg = fakeConfig({ darkSites: '[]' });
  const mem = createSiteMemory(cfg, 'dark');

  assert.equal(mem.has('a.test'), false);
  await mem.enable('a.test');
  assert.equal(mem.has('a.test'), true);
  assert.deepEqual(JSON.parse(cfg.store.darkSites), ['a.test']);

  await mem.disable('a.test');
  assert.equal(mem.has('a.test'), false);
  assert.deepEqual(JSON.parse(cfg.store.darkSites), []);
});

test('FAIL-SAFE: disable 不存在的站点不写存储', async () => {
  const cfg = fakeConfig({ darkSites: '["a.test"]' });
  const mem = createSiteMemory(cfg, 'dark');
  const before = cfg.store.darkSites;
  const r = await mem.disable('ghost.test');
  assert.equal(r.changed, false);
  assert.equal(cfg.store.darkSites, before);
});

test('PASS: clear 清空', async () => {
  const cfg = fakeConfig({ darkSites: '["a.test","b.test"]' });
  const mem = createSiteMemory(cfg, 'dark');
  await mem.clear();
  assert.deepEqual(mem.list(), []);
});

test('FAIL-SAFE: 名单里的脏数据被清洗（不让无效域名进存储）', () => {
  const cfg = fakeConfig({ darkSites: '["a.test","bad entry","https://x/","a.test"]' });
  const mem = createSiteMemory(cfg, 'dark');
  assert.deepEqual(mem.list(), ['a.test']);
});

test('FAIL-SAFE: 存储里是坏 JSON 时 list 不抛错', () => {
  const cfg = fakeConfig({ darkSites: '{坏掉' });
  const mem = createSiteMemory(cfg, 'dark');
  assert.deepEqual(mem.list(), []);
  assert.equal(mem.has('a.test'), false);
});

test('FAIL-SAFE: 未初始化的键返回空名单', () => {
  const cfg = fakeConfig({});
  const mem = createSiteMemory(cfg, 'dark');
  assert.deepEqual(mem.list(), []);
});
