'use strict';

/* 界面行为自测（mock 数据，不落盘）：electron test/ui-check.js */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.disableHardwareAcceleration();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
let passed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  const exec = (code) => win.webContents.executeJavaScript(code);

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(600);

  await exec(`
    document.getElementById('masterInput').value = 'demo-password';
    document.getElementById('lockForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  `);
  await wait(700);

  check('解锁后隐藏锁屏并显示主界面', await exec(`document.getElementById('shell').hidden === false && document.getElementById('lockScreen').classList.contains('is-hidden')`));
  check('初始列出全部 8 条', await exec(`document.querySelectorAll('.entry').length === 8`));

  await exec(`
    const q = document.getElementById('searchInput');
    q.value = '腾讯';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  check('搜索“腾讯”命中 1 条', await exec(`document.querySelectorAll('.entry').length === 1 && document.getElementById('listCount').textContent === '1'`));

  await exec(`document.getElementById('clearSearchBtn').click()`);
  await exec(`document.querySelector('[data-category="邮箱"]').click()`);
  check('分类筛选“邮箱”只剩 1 条', await exec(`document.querySelectorAll('.entry').length === 1 && document.getElementById('listTitle').textContent === '邮箱'`));

  await exec(`document.querySelector('[data-category="all"]').click()`);
  check('切回全部分类恢复 8 条', await exec(`document.querySelectorAll('.entry').length === 8`));

  await exec(`document.querySelector('.entry').click()`);
  check('点击条目后详情显示标题', await exec(`document.querySelector('.detail-titles h2')?.textContent === 'GitHub'`));
  check('密码默认掩码显示', await exec(`document.querySelector('.secret-value')?.classList.contains('masked')`));

  await exec(`document.querySelector('[data-action="toggle-reveal"]').click()`);
  check('点击眼睛后显示明文密码', await exec(`document.querySelector('.secret-value')?.textContent === 'kR7#vQm2!xLp9@Wd'`));

  await exec(`document.querySelector('[data-action="copy-password"]').click()`);
  await wait(300);
  check('复制密码出现提示', await exec(`document.querySelectorAll('.toast').length > 0`));
  check('提示包含剪贴板清除时长', await exec(`document.querySelector('.toast')?.textContent.includes('30 秒后自动清除')`));

  const firstBefore = await exec(`document.querySelector('.entry .entry-title').textContent`);
  await exec(`document.getElementById('sortBtn').click()`);
  const firstAfter = await exec(`document.querySelector('.entry .entry-title').textContent`);
  check('切换排序后首条变化', firstBefore !== firstAfter, `${firstBefore} -> ${firstAfter}`);
  await exec(`document.getElementById('sortBtn').click()`);

  await exec(`document.querySelector('[data-action="settings"]').click()`);
  await wait(400);
  check('设置面板打开并显示自动锁定', await exec(`document.querySelector('.modal h3')?.textContent === '设置' && document.querySelector('[data-setting="autoLockMinutes"]')?.value === '5'`));

  // —— 明文导出 ——
  check('设置里有 CSV / JSON 导出入口', await exec(`document.querySelectorAll('[data-action="export-plain"]').length === 2`));
  check('明文导出带风险提示', await exec(`document.querySelector('.warn-inline')?.textContent.includes('明文')`));

  await exec(`document.querySelector('[data-action="export-plain"][data-format="csv"]').click()`);
  await wait(400);
  check('明文导出先弹二次确认', await exec(`document.querySelector('.confirm-copy')?.textContent.includes('明文')`));
  await exec(`document.querySelector('[data-action="confirm-yes"]').click()`);
  await wait(400);
  check('确认后完成 CSV 导出', await exec(`document.body.textContent.includes('已导出 8 条到 CSV')`));

  await exec(`document.querySelector('[data-action="export-plain"][data-format="json"]').click()`);
  await wait(400);
  await exec(`document.querySelector('[data-action="confirm-yes"]').click()`);
  await wait(400);
  check('JSON 导出同样可用', await exec(`document.body.textContent.includes('已导出 8 条到 JSON')`));


  await exec(`document.querySelector('[data-action="import-browser"]').click()`);
  await wait(500);

  // —— 一键导入（主路径，多文件）——
  check('弹层优先展示一键导入卡片', await exec(`document.querySelector('.quick-card') !== null`));
  check('两个 CSV 时显示「2 个文件」', await exec(`document.querySelector('.quick-name')?.textContent.includes('2 个文件')`));
  check('多文件时逐个列出文件名', await exec(`document.querySelectorAll('.quick-filelist li').length === 2`));
  check('新鲜的多文件标绿提示', await exec(`document.querySelector('.import-fresh')?.textContent.includes('2 分钟前')`));
  check('按钮提示合并导入数量', await exec(`document.querySelector('[data-action="quick-import"]')?.textContent.includes('这 2 个')`));
  check('说明会合并去重', await exec(`document.querySelector('.quick-hint')?.textContent.includes('合并导入')`));

  await exec(`document.querySelector('[data-action="quick-import"]').click()`);
  await wait(400);
  check('多文件导入显示新增条数', await exec(`document.querySelector('.import-result')?.textContent.includes('新增 64 条')`));
  check('结果前缀标明是几个文件', await exec(`document.querySelector('.import-result')?.textContent.includes('2 个文件')`));
  check('导入后出现删除明文按钮', await exec(`document.querySelector('[data-action="discard-csv"]') !== null`));
  check('删除按钮标明文件数', await exec(`document.querySelector('[data-action="discard-csv"]')?.textContent.includes('这 2 个')`));
  check('导入后主按钮变为可重试', await exec(`document.querySelector('[data-action="quick-import"]')?.textContent === '再导入一次'`));
  check('导入后文件名旁显示已导入', await exec(`document.querySelector('.quick-meta')?.textContent.includes('已导入')`));

  await exec(`document.querySelector('[data-action="discard-csv"]').click()`);
  await wait(300);
  check('批量删除明文 CSV 后提示数量', await exec(`document.querySelector('[data-action="discard-csv"]')?.textContent.includes('已删除 2 个')`));

  // —— 兜底区：直接读浏览器 ——
  await exec(`document.querySelector('.import-more').open = true`);
  await wait(200);
  check('导入弹层列出检测到的浏览器', await exec(`document.querySelectorAll('.import-source').length === 2`));
  check('浏览器行显示可导入数量', await exec(`document.querySelector('.import-source-main span')?.textContent.includes('25 条')`));
  check('提示应用绑定加密并引导 CSV', await exec(`document.querySelector('.import-warn')?.textContent.includes('应用绑定加密')`));
  check('全为 v20 的浏览器改为导出步骤', await exec(`document.querySelectorAll('[data-action="focus-csv"]').length === 1 && document.querySelectorAll('[data-action="import-profile"]').length === 1`));

  check('导出步骤按钮可展开说明', await exec(`
    (() => {
      document.querySelector('[data-action="focus-csv"]').click();
      return document.querySelector('.import-steps')?.open === true;
    })()
  `));

  await exec(`document.querySelector('[data-action="import-profile"]').click()`);
  await wait(400);
  check('浏览器导入显示结果汇总', await exec(`document.querySelector('.import-result')?.textContent.includes('新增 20 条')`));

  // —— 兜底区：手动选 CSV ——
  await exec(`document.querySelector('[data-action="pick-csv"]').click()`);
  await wait(300);
  check('选择 CSV 后显示预览', await exec(`document.querySelector('#csvPreview')?.textContent.includes('passwords.csv')`));
  await exec(`document.querySelector('[data-action="import-csv"]').click()`);
  await wait(300);
  check('CSV 导入显示汇总', await exec(`document.querySelector('.import-result')?.textContent.includes('新增 60 条')`));

  await exec(`document.querySelector('[data-action="close-modal"]').click()`);
  await wait(200);
  await exec(`document.querySelector('[data-action="close-modal"]').click()`);
  await wait(200);

  await exec(`promptImportOnFirstRun()`);
  await wait(300);
  check('首次引导弹层出现', await exec(`document.querySelector('.modal h3')?.textContent === '把浏览器里的密码带进来？'`));
  await exec(`document.querySelector('[data-action="start-onboard"]').click()`);
  await wait(500);
  check('引导可直接进入导入弹层', await exec(`document.querySelector('.modal h3')?.textContent === '导入浏览器密码'`));
  await exec(`document.querySelector('[data-action="close-modal"]').click()`);
  await wait(200);

  await exec(`document.querySelector('[data-action="new"]')?.click() || document.getElementById('newEntryBtn').click()`);
  await wait(400);
  check('新建表单默认分类为网站', await exec(`document.getElementById('fCategory')?.value === '网站'`));
  await exec(`document.querySelector('[data-action="open-generator"]').click()`);
  await wait(500);
  check('生成器叠层打开且编辑器仍在下方', await exec(`document.querySelectorAll('.modal').length === 2`));
  await exec(`document.querySelector('[data-action="gen-use"]').click()`);
  await wait(300);
  check('生成器“使用此密码”回填编辑器', await exec(`document.getElementById('fPassword').value.length >= 8 && document.querySelectorAll('.modal').length === 1`));
  await exec(`document.querySelector('[data-action="close-modal"]').click()`);
  await wait(300);

  await exec(`document.querySelector('[data-action="delete"]').click()`);
  await wait(400);
  check('删除前弹出确认框', await exec(`document.querySelector('.modal h3')?.textContent === '删除条目'`));
  await exec(`document.querySelector('[data-action="confirm-no"]').click()`);
  await wait(200);
  check('取消删除后确认框关闭', await exec(`document.querySelectorAll('.modal').length === 0`));

  await exec(`document.querySelector('[data-action="lock"]').click()`);
  await wait(500);
  check('手动锁定后回到锁屏', await exec(`document.getElementById('shell').hidden === true && !document.getElementById('lockScreen').classList.contains('is-hidden')`));

  console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
  if (failures.length) process.exitCode = 1;
  app.quit();
});
