'use strict';

/**
 * 明文导出的单元测试。
 *
 * 重点验证：
 *   - CSV 转义（逗号 / 引号 / 换行 / 中文）
 *   - 导出的 CSV 能被自家 itemsFromCsv 重新读回（往返一致）
 *   - JSON 保留完整字段
 *   - 空仓库不产生残缺文件
 */

const assert = require('node:assert');

const exporter = require('../src/main/export');
const { itemsFromCsv } = require('../src/main/browser-import');

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

const SAMPLE = [
  {
    title: 'GitHub',
    url: 'https://github.com',
    username: 'alice@example.com',
    password: 'ghP@ssw0rd!',
    category: '网站',
    notes: '开启了两步验证',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    title: '腾讯云',
    url: 'https://console.cloud.tencent.com',
    username: 'admin@example.com',
    password: 'Tc-2026!Aq7',
    category: '服务器',
    notes: '',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  },
];

console.log('\n[CSV 转义]');

test('普通字段不加引号', () => {
  assert.strictEqual(exporter.csvCell('abc'), 'abc');
});

test('含逗号的字段加引号', () => {
  assert.strictEqual(exporter.csvCell('a,b'), '"a,b"');
});

test('含引号的字段：引号翻倍并整体加引号', () => {
  assert.strictEqual(exporter.csvCell('say "hi"'), '"say ""hi"""');
});

test('含换行的字段加引号', () => {
  assert.strictEqual(exporter.csvCell('line1\nline2'), '"line1\nline2"');
});

test('null / undefined 变成空串', () => {
  assert.strictEqual(exporter.csvCell(null), '');
  assert.strictEqual(exporter.csvCell(undefined), '');
});

test('中文不受影响', () => {
  assert.strictEqual(exporter.csvCell('钥巢'), '钥巢');
});

console.log('\n[CSV 结构]');

test('表头是 Chrome 兼容的列名', () => {
  const csv = exporter.toCsv([]);
  assert.strictEqual(csv.split('\r\n')[0], 'name,url,username,password,note');
});

test('每条记录占一行，行尾有换行', () => {
  const csv = exporter.toCsv(SAMPLE);
  const lines = csv.trimEnd().split('\r\n');
  assert.strictEqual(lines.length, 3, `实际 ${lines.length} 行`);
  assert.ok(csv.endsWith('\r\n'));
});

test('空仓库只产出表头', () => {
  const csv = exporter.toCsv([]);
  assert.strictEqual(csv.trimEnd().split('\r\n').length, 1);
});

console.log('\n[往返一致性]');

test('导出的 CSV 能被自己读回，且密码无损', () => {
  const csv = exporter.toCsv(SAMPLE);
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items.length, 2);

  const byTitle = new Map(items.map((i) => [i.title, i]));
  assert.strictEqual(byTitle.get('GitHub').username, 'alice@example.com');
  assert.strictEqual(byTitle.get('GitHub').password, 'ghP@ssw0rd!');
  assert.strictEqual(byTitle.get('腾讯云').password, 'Tc-2026!Aq7');
});

test('特殊字符密码往返一致', () => {
  const tricky = [
    {
      title: 'Tricky',
      url: 'https://t.test',
      username: 'u',
      password: 'p,a"s\ns',
      notes: '',
    },
  ];
  const csv = exporter.toCsv(tricky);
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items[0].password, 'p,a"s\ns');
});

test('备注里的换行往返一致', () => {
  const withNote = [
    { title: 'N', url: 'https://n.test', username: 'u', password: 'p', notes: '第一行\n第二行' },
  ];
  const csv = exporter.toCsv(withNote);
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items[0].password, 'p');
  // note 列不在导入映射里，但不应影响解析
  assert.strictEqual(items.length, 1);
});

console.log('\n[JSON 导出]');

test('包含格式标识与时间戳', () => {
  const json = JSON.parse(exporter.toJson(SAMPLE));
  assert.strictEqual(json.format, 'keynest.export.v1');
  assert.ok(json.exportedAt);
  assert.strictEqual(json.count, 2);
});

test('保留完整字段（含备注与时间）', () => {
  const json = JSON.parse(exporter.toJson(SAMPLE));
  const first = json.entries[0];
  assert.strictEqual(first.title, 'GitHub');
  assert.strictEqual(first.notes, '开启了两步验证');
  assert.strictEqual(first.category, '网站');
  assert.strictEqual(first.createdAt, '2026-01-01T00:00:00.000Z');
});

test('可携带额外元信息', () => {
  const json = JSON.parse(exporter.toJson(SAMPLE, { categories: ['网站', '服务器'] }));
  assert.deepStrictEqual(json.categories, ['网站', '服务器']);
});

test('空仓库导出为空数组', () => {
  const json = JSON.parse(exporter.toJson([]));
  assert.strictEqual(json.count, 0);
  assert.deepStrictEqual(json.entries, []);
});

console.log('\n[文件名]');

test('文件名带扩展名与时间戳', () => {
  const when = new Date(2026, 9, 31, 16, 20);
  assert.strictEqual(exporter.suggestFileName('csv', when), 'keynest-20261031-1620.csv');
  assert.strictEqual(exporter.suggestFileName('json', when), 'keynest-20261031-1620.json');
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
