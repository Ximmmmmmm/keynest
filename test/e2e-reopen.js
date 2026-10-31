'use strict';

/* 端到端测试（阶段二）：重新启动后用主密码解锁，验证条目从磁盘正确解密 */

process.env.KEYNEST_DATA_DIR = process.env.KEYNEST_DATA_DIR || require('node:path').join(__dirname, 'e2e-data');

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exec = (win, code) => win.webContents.executeJavaScript(code);

async function waitForWindow() {
  for (let i = 0; i < 100; i += 1) {
    const [win] = BrowserWindow.getAllWindows();
    if (win && !win.webContents.isLoading()) return win;
    await wait(100);
  }
  throw new Error('窗口未就绪');
}

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow();
    await wait(600);

    const isCreateMode = await exec(win, `document.getElementById('lockTitle').textContent === '设置主密码'`);
    if (isCreateMode) throw new Error('仓库未被识别为已存在');

    await exec(win, `
      document.getElementById('masterInput').value = 'E2E-Master-2026!';
      document.getElementById('lockForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await wait(2200);

    const entered = await exec(win, `!document.getElementById('shell').hidden`);
    if (!entered) throw new Error('主密码解锁失败');

    await wait(1000);
    const modalCount = await exec(win, `document.querySelectorAll('.modal').length`);
    if (modalCount !== 0) throw new Error('已存在的密码库不应再弹出首次导入引导');

    const found = await exec(win, `document.getElementById('entryList').innerText.includes('E2E 测试条目')`);
    if (!found) throw new Error('重启后未读到条目');

    const detail = await exec(win, `document.getElementById('detailPane').innerText`);
    if (!detail.includes('e2e@test.local')) throw new Error('详情未解密显示账号');

    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'shots', 'e2e-reopened.png'), image.toPNG());

    console.log('E2E-REOPEN-OK');
  } catch (err) {
    console.error('E2E-REOPEN-FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
