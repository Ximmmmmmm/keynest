'use strict';

/**
 * CSV 自动发现的单元测试。
 * 全部在临时目录里跑，不碰真实下载目录。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const discovery = require('../src/main/csv-discovery');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-csv-'));
}

function touch(dir, name, { content = 'name,url,username,password\nA,https://a.test,u,p\n', ageMs = 0 } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, when, when);
  }
  return file;
}

console.log('\n[候选收集]');

test('只收集 .csv，忽略其它类型', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'a.csv');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'c.json'), '{}');
    const { fresh, stale, scannedDirs } = discovery.collect([dir]);
    const names = [...fresh, ...stale].map((i) => i.name).sort();
    assert.deepStrictEqual(names, ['a.csv']);
    assert.deepStrictEqual(scannedDirs, [dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('跳过空文件', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'empty.csv'), '');
    const { fresh, stale } = discovery.collect([dir]);
    assert.strictEqual(fresh.length + stale.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('5 分钟内算新鲜，超过算陈旧', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'new.csv', { ageMs: 30 * 1000 }); // 30 秒
    touch(dir, 'old.csv', { ageMs: 60 * 60 * 1000 }); // 1 小时
    const { fresh, stale } = discovery.collect([dir]);
    assert.strictEqual(fresh.length, 1, '应有 1 个新鲜文件');
    assert.strictEqual(fresh[0].name, 'new.csv');
    assert.strictEqual(stale.length, 1, '应有 1 个陈旧文件');
    assert.strictEqual(stale[0].name, 'old.csv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('目录不存在时安全跳过', () => {
  const missing = path.join(os.tmpdir(), 'keynest-definitely-missing-' + Date.now());
  const { fresh, stale, scannedDirs } = discovery.collect([missing]);
  assert.strictEqual(fresh.length + stale.length, 0);
  assert.deepStrictEqual(scannedDirs, [], '读不到的目录不应计入已扫描');
});

console.log('\n[挑选规则]');

test('有新鲜文件时 confident=true，取最新的', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'a.csv', { ageMs: 120 * 1000 }); // 2 分钟
    touch(dir, 'b.csv', { ageMs: 10 * 1000 }); // 10 秒
    const result = discovery.discover([dir]);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.confident, true);
    assert.strictEqual(result.file.name, 'b.csv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('多个新鲜文件全部返回（Chrome + Edge 各导一份）', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'Chrome 密码.csv', { ageMs: 60 * 1000 });
    touch(dir, 'Edge 密码.csv', { ageMs: 90 * 1000 });
    const result = discovery.discover([dir]);
    assert.strictEqual(result.files.length, 2, `应返回两个文件，实际 ${result.files.length}`);
    const names = result.files.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ['Chrome 密码.csv', 'Edge 密码.csv']);
    // 按修改时间从新到旧
    assert.strictEqual(result.files[0].name, 'Chrome 密码.csv', '最新的应排第一');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('新鲜与陈旧混合时只取新鲜的', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'fresh.csv', { ageMs: 30 * 1000 });
    touch(dir, 'old.csv', { ageMs: 2 * 60 * 60 * 1000 });
    const result = discovery.discover([dir]);
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].name, 'fresh.csv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('只有陈旧文件时 confident=false', () => {
  const dir = tmpDir();
  try {
    touch(dir, 'old.csv', { ageMs: 3 * 24 * 60 * 60 * 1000 }); // 3 天
    const result = discovery.discover([dir]);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.confident, false);
    assert.strictEqual(result.file.name, 'old.csv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('完全没有 CSV 时 found=false', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'readme.md'), 'x');
    const result = discovery.discover([dir]);
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.file, null);
    assert.deepStrictEqual(result.candidates, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件过多时截断到上限并标记', () => {
  const dir = tmpDir();
  try {
    for (let i = 0; i < 14; i += 1) touch(dir, `f${i}.csv`, { ageMs: i * 1000 });
    const result = discovery.discover([dir]);
    assert.strictEqual(result.files.length, discovery.MAX_FILES, `实际 ${result.files.length}`);
    assert.strictEqual(result.truncated, true, '超出上限时应标记 truncated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('排序稳定：mtime 相同按路径', () => {
  const dir = tmpDir();
  try {
    const a = touch(dir, 'aa.csv');
    const b = touch(dir, 'bb.csv');
    const when = Date.now() / 1000 - 60;
    fs.utimesSync(a, when, when);
    fs.utimesSync(b, when, when);
    const r1 = discovery.discover([dir]);
    const r2 = discovery.discover([dir]);
    assert.strictEqual(r1.file.name, 'aa.csv');
    assert.strictEqual(r2.file.name, 'aa.csv', '多次调用结果应一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n[人性化描述]');

test('describeAge 输出可读文本', () => {
  assert.strictEqual(discovery.describeAge(5 * 1000), '刚刚');
  assert.strictEqual(discovery.describeAge(5 * 60 * 1000), '5 分钟前');
  assert.strictEqual(discovery.describeAge(3 * 60 * 60 * 1000), '3 小时前');
  assert.strictEqual(discovery.describeAge(2 * 24 * 60 * 60 * 1000), '2 天前');
});

console.log('\n[默认目录]');

test('默认目录含下载文件夹', () => {
  const dirs = discovery.defaultDirs();
  assert.ok(
    dirs.some((d) => /Downloads$/i.test(d)),
    `dirs=${dirs.join(',')}`,
  );
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
