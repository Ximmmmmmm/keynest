// 豁免名单的测试。
//
// 这份名单的风险在"点了暂停但还在拦"或"删了豁免却还放行"——
// 两种都表现为用户觉得这个功能坏了，而且没有任何报错。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ALLOWLIST,
  addEntry,
  isAllowed,
  normalizeEntry,
  parseAllowlist,
  removeEntry,
  sanitizeAllowlist,
} from '../lib/filters/allowlist.js';

/* ============================ 规范化 ============================ */

test('PASS: 条目规范化（大小写、尾点、端口）', () => {
  assert.equal(normalizeEntry('Example.TEST'), 'example.test');
  assert.equal(normalizeEntry('example.test.'), 'example.test');
  assert.equal(normalizeEntry('example.test:8080'), 'example.test');
});

test('FAIL-SAFE: 非域名输入返回 null', () => {
  for (const bad of ['', '  ', null, undefined, 123, {}, 'a b', 'a/b', 'https://example.test/']) {
    assert.equal(normalizeEntry(bad), null, String(bad));
  }
});

test('FAIL-SAFE: 带协议的 URL 不被接受（我们只存域名）', () => {
  // 存 URL 会带来"路径变了还算不算豁免"的歧义，也会泄露浏览历史
  assert.equal(normalizeEntry('https://example.test/path?q=1'), null);
});

/* ============================ 清洗 ============================ */

test('PASS: 清洗非法项、去重、保序', () => {
  const raw = ['b.test', 'a.test', 'b.test', '', null, 'c.test', 'a.test:443'];
  assert.deepEqual(sanitizeAllowlist(raw), ['b.test', 'a.test', 'c.test']);
});

test('FAIL-SAFE: 非数组输入得到空名单（不猜）', () => {
  for (const bad of [null, undefined, 'a.test', 42, {}]) {
    assert.deepEqual(sanitizeAllowlist(bad), [], String(bad));
  }
});

test('FAIL-SAFE: 超长名单被截断到上限', () => {
  const raw = Array.from({ length: MAX_ALLOWLIST + 50 }, (_, i) => `s${i}.test`);
  const out = sanitizeAllowlist(raw);
  assert.equal(out.length, MAX_ALLOWLIST);
  assert.equal(out[0], 's0.test', '截断该丢尾部，不是头部');
});

test('FAIL-SAFE: 上限是 200（不设限会让规则安装超时）', () => {
  assert.equal(MAX_ALLOWLIST, 200);
});

/* ============================ 增删 ============================ */

test('PASS: 新加的在最前', () => {
  const { list, added, moved } = addEntry(['a.test'], 'b.test');
  assert.deepEqual(list, ['b.test', 'a.test']);
  assert.equal(added, true);
  assert.equal(moved, false);
});

test('PASS: 重复添加会提到最前（用户再点一次通常是想确认它还在）', () => {
  const { list, added, moved } = addEntry(['a.test', 'b.test'], 'b.test');
  assert.deepEqual(list, ['b.test', 'a.test']);
  assert.equal(added, false);
  assert.equal(moved, true);
});

test('PASS: 已在最前时不做无意义改动（返回同一个引用）', () => {
  const cur = ['a.test', 'b.test'];
  const { list, added, moved } = addEntry(cur, 'a.test');
  assert.equal(list, cur, '应该返回同一个数组，避免触发不必要的写存储');
  assert.equal(added, false);
  assert.equal(moved, false);
});

test('FAIL-SAFE: 非法域名不改变名单', () => {
  const cur = ['a.test'];
  const { list, added } = addEntry(cur, 'not a domain');
  assert.equal(list, cur);
  assert.equal(added, false);
});

test('PASS: 添加时超上限丢最旧的', () => {
  const cur = Array.from({ length: MAX_ALLOWLIST }, (_, i) => `s${i}.test`);
  const { list } = addEntry(cur, 'new.test');
  assert.equal(list.length, MAX_ALLOWLIST);
  assert.equal(list[0], 'new.test');
  assert.equal(list.includes(`s${MAX_ALLOWLIST - 1}.test`), false, '最旧的该被丢掉');
});

test('PASS: 移除', () => {
  const { list, removed } = removeEntry(['a.test', 'b.test'], 'b.test');
  assert.deepEqual(list, ['a.test']);
  assert.equal(removed, true);
});

test('FAIL-SAFE: 移除不存在的项不算成功', () => {
  const cur = ['a.test'];
  const { list, removed } = removeEntry(cur, 'ghost.test');
  assert.deepEqual(list, cur);
  assert.equal(removed, false);
});

test('FAIL-SAFE: 移除时的规范化与添加一致', () => {
  const { removed } = removeEntry(['example.test'], 'EXAMPLE.TEST.');
  assert.equal(removed, true);
});

/* ============================ 匹配 ============================ */

test('PASS: 自身与子域都算豁免', () => {
  const list = ['example.test'];
  assert.equal(isAllowed(list, 'example.test'), true);
  assert.equal(isAllowed(list, 'www.example.test'), true);
  assert.equal(isAllowed(list, 'a.b.example.test'), true);
});

test('FAIL-SAFE: 标签边界 —— notexample.test 不被豁免', () => {
  // 写成 host.endsWith(d) 会在这里返回 true。
  // 表现是"豁免了 example.test，结果 notexample.test 也开始放行"——过滤悄悄失效。
  const list = ['example.test'];
  assert.equal(isAllowed(list, 'notexample.test'), false);
  assert.equal(isAllowed(list, 'example.test.evil.test'), false);
});

test('FAIL-SAFE: 空名单不豁免任何东西', () => {
  assert.equal(isAllowed([], 'example.test'), false);
  assert.equal(isAllowed([], ''), false);
});

test('FAIL-SAFE: 非法 host 不豁免', () => {
  assert.equal(isAllowed(['example.test'], ''), false);
  assert.equal(isAllowed(['example.test'], null), false);
  assert.equal(isAllowed(['example.test'], 'a b'), false);
});

test('PASS: 大小写与尾点不能绕过匹配', () => {
  assert.equal(isAllowed(['example.test'], 'WWW.EXAMPLE.TEST.'), true);
});

/* ============================ 解析 ============================ */

test('PASS: 从配置字符串解析', () => {
  assert.deepEqual(parseAllowlist('["a.test","b.test"]'), ['a.test', 'b.test']);
});

test('FAIL-SAFE: 坏 JSON 当空名单（坏数据不该让功能整体不可用）', () => {
  for (const bad of ['{', 'null', '"[1,2"', '"not-an-array"', '', '123']) {
    assert.deepEqual(parseAllowlist(bad), [], bad);
  }
});

test('FAIL-SAFE: 解析后仍会清洗', () => {
  assert.deepEqual(parseAllowlist('["a.test","a.test","bad entry"]'), ['a.test']);
});
