'use strict';

/**
 * 导入弹窗的纯渲染函数测试。
 *
 * 这些函数只做「数据 → HTML 字符串」，不碰 DOM。
 * 通过 vm 加载 app.js 里的函数（app.js 依赖浏览器全局，需要最小 shim）。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

/** 从 app.js 里抽出需要的函数，注入最小依赖后执行 */
function loadRenderers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

  // 抓取目标函数（从 function 名开始到下一个顶层 function 之前）
  const names = [
    'esc',
    'formatSize',
    'renderQuickCard',
    'renderImportResult',
    'renderBrowserSources',
    'renderAppBoundWarn',
    'renderDiscardRow',
  ];

  const sandbox = {
    // 最小 shim：图标与配色只影响外观，测试里用占位实现
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    colorFor: () => ({ fg: '#333', bg: '#eee' }),
  };

  const chunks = [];
  for (const name of names) {
    const startRe = new RegExp(`^(?:const|function) ${name}\\b`, 'm');
    const match = startRe.exec(source);
    if (!match) throw new Error(`找不到函数 ${name}`);
    const start = match.index;
    // 找到下一个顶层声明作为结束
    const rest = source.slice(start + 1);
    const nextRe = /\n(?:function |const [A-Za-z_$][\w$]* = |let |var |\/\*\*)/;
    const rel = nextRe.exec(rest);
    const end = rel ? start + 1 + rel.index : source.length;
    chunks.push(source.slice(start, end).trim());
  }

  const code = chunks.join('\n\n');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const R = loadRenderers();

console.log('\n[一键导入卡片]');

test('没有文件时给出重新查找按钮', () => {
  const html = R.renderQuickCard({ found: false, files: [], file: null });
  assert.ok(html.includes('还没找到 CSV 文件'), '应提示没找到');
  assert.ok(html.includes('data-action="rescan-csv"'), '应提供重新查找');
});

test('单个文件显示文件名与「一键导入」', () => {
  const html = R.renderQuickCard({
    found: true,
    confident: true,
    truncated: false,
    files: [{ name: 'Chrome 密码.csv', size: 8421, ageLabel: '2 分钟前' }],
    file: { name: 'Chrome 密码.csv' },
  });
  assert.ok(html.includes('Chrome 密码.csv'));
  assert.ok(html.includes('一键导入'), '按钮文案');
  assert.ok(html.includes('2 分钟前'), '应显示新鲜度');
});

test('多个文件显示数量并逐个列出', () => {
  const html = R.renderQuickCard({
    found: true,
    confident: true,
    truncated: false,
    files: [
      { name: 'Chrome 密码.csv', size: 8421, ageLabel: '2 分钟前' },
      { name: 'Edge 密码.csv', size: 21500, ageLabel: '3 分钟前' },
    ],
    file: { name: 'Chrome 密码.csv' },
  });
  assert.ok(html.includes('2 个文件'), '应显示文件数');
  assert.ok(html.includes('Chrome 密码.csv') && html.includes('Edge 密码.csv'), '应列出两个文件名');
  assert.ok(html.includes('一键导入这 2 个'), '按钮文案应带数量');
  assert.ok(html.includes('合并导入'), '应说明会合并');
});

test('陈旧文件给出黄色提醒', () => {
  const html = R.renderQuickCard({
    found: true,
    confident: false,
    truncated: false,
    files: [{ name: 'old.csv', size: 100, ageLabel: '3 天前' }],
    file: { name: 'old.csv' },
  });
  assert.ok(html.includes('import-stale'), '应使用陈旧样式');
  assert.ok(html.includes('可能不是刚导出的'));
});

test('超出上限时提示截断', () => {
  const html = R.renderQuickCard({
    found: true,
    confident: true,
    truncated: true,
    files: [{ name: 'a.csv', size: 1, ageLabel: '刚刚' }],
    file: { name: 'a.csv' },
  });
  assert.ok(html.includes('文件较多'), '应提示只导入了部分');
});

test('文件名里的特殊字符被转义', () => {
  const html = R.renderQuickCard({
    found: true,
    confident: true,
    truncated: false,
    files: [{ name: '<script>x.csv', size: 1, ageLabel: '刚刚' }],
    file: { name: '<script>x.csv' },
  });
  assert.ok(!html.includes('<script>'), '文件名不应原样注入 HTML');
  assert.ok(html.includes('&lt;script&gt;'), '应转义为实体');
});

console.log('\n[导入结果摘要]');

test('基本结果包含新增条数', () => {
  const html = R.renderImportResult({ added: 5, updated: 0, skipped: 0 });
  assert.ok(html.includes('新增 5 条'));
});

test('有更新与跳过时一并显示', () => {
  const html = R.renderImportResult({ added: 3, updated: 2, skipped: 4 });
  assert.ok(html.includes('新增 3 条'));
  assert.ok(html.includes('更新 2 条'));
  assert.ok(html.includes('跳过 4 条'));
});

test('应用绑定加密时给出 CSV 引导', () => {
  const html = R.renderImportResult({ added: 0, updated: 0, skipped: 0, appBound: 25 });
  assert.ok(html.includes('25 条需改用 CSV'));
  assert.ok(html.includes('应用绑定加密'));
});

test('前缀会被转义', () => {
  const html = R.renderImportResult({ added: 1, updated: 0, skipped: 0 }, '<x>:');
  assert.ok(!html.includes('<x>:'));
});

console.log('\n[浏览器来源列表]');

test('空列表给出明确提示', () => {
  const r = R.renderBrowserSources([]);
  assert.strictEqual(r.appBoundTotal, 0);
  assert.ok(r.html.includes('没有检测到'));
});

test('可导入的配置显示「导入」按钮', () => {
  const r = R.renderBrowserSources([
    {
      id: 'chrome',
      name: 'Google Chrome',
      profiles: [{ dir: 'Default', label: '默认配置', count: 25, appBound: 0, importable: 25 }],
    },
  ]);
  assert.strictEqual(r.appBoundTotal, 0);
  assert.ok(r.html.includes('data-action="import-profile"'));
  assert.ok(r.html.includes('25 条'));
});

test('全部 v20 的配置改为「导出步骤」', () => {
  const r = R.renderBrowserSources([
    {
      id: 'edge',
      name: 'Microsoft Edge',
      profiles: [{ dir: 'Default', label: '默认配置', count: 82, appBound: 82, importable: 0 }],
    },
  ]);
  assert.strictEqual(r.appBoundTotal, 82);
  assert.ok(r.html.includes('data-action="focus-csv"'));
  assert.ok(!r.html.includes('data-action="import-profile"'));
  assert.ok(r.html.includes('全部需用 CSV 导出'));
});

test('多个来源的 appBound 累加', () => {
  const r = R.renderBrowserSources([
    { id: 'a', name: 'A', profiles: [{ dir: 'Default', label: 'd', count: 10, appBound: 10, importable: 0 }] },
    { id: 'b', name: 'B', profiles: [{ dir: 'Default', label: 'd', count: 20, appBound: 5, importable: 15 }] },
  ]);
  assert.strictEqual(r.appBoundTotal, 15);
});

test('读不到库时给出关闭浏览器提示', () => {
  const r = R.renderBrowserSources([
    { id: 'x', name: 'X', profiles: [{ dir: 'Default', label: 'd', count: -1, appBound: 0, importable: 0 }] },
  ]);
  assert.ok(r.html.includes('无法读取'));
});

console.log('\n[其他片段]');

test('appBound 为 0 时不显示警告', () => {
  assert.strictEqual(R.renderAppBoundWarn(0), '');
});

test('appBound 大于 0 时显示总量', () => {
  const html = R.renderAppBoundWarn(25);
  assert.ok(html.includes('25 条'));
  assert.ok(html.includes('应用绑定加密'));
});

test('删除按钮在单文件时用单数文案', () => {
  const html = R.renderDiscardRow(['a.csv']);
  assert.ok(html.includes('删掉这个 CSV'));
});

test('删除按钮在多文件时用复数文案并带路径', () => {
  const html = R.renderDiscardRow(['a.csv', 'b.csv']);
  assert.ok(html.includes('删掉这 2 个 CSV'));
  assert.ok(html.includes('data-paths='));
});

test('路径为空时提示无需删除', () => {
  const html = R.renderDiscardRow([]);
  assert.ok(html.includes('无需删除'));
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
