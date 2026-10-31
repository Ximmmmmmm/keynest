'use strict';

/* 端到端测试（阶段一）：真实主进程 + 真实 UI 创建密码库并写入条目
   运行：electron test/e2e-create.js  （需 VAULTKEEPER_DATA_DIR 指向临时目录） */

process.env.KEYNEST_DATA_DIR = process.env.KEYNEST_DATA_DIR || require('node:path').join(__dirname, 'e2e-data');

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 让脚本可重复运行：先清掉上一次的仓库文件（仅测试目录内的两个文件）
for (const name of ['vault.dat', 'vault.dat.bak']) {
  fs.rmSync(path.join(process.env.KEYNEST_DATA_DIR, name), { force: true });
}

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

    await exec(win, `
      document.getElementById('masterInput').value = 'E2E-Master-2026!';
      document.getElementById('masterConfirm').value = 'E2E-Master-2026!';
      document.getElementById('lockForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await wait(2200);

    const entered = await exec(win, `!document.getElementById('shell').hidden`);
    if (!entered) throw new Error('创建密码库后未进入主界面');

    // 首次引导会在这时弹出，先跳过，让后续步骤在干净界面上进行
    if (await exec(win, `!!document.querySelector('[data-action="skip-onboard"]')`)) {
      await exec(win, `document.querySelector('[data-action="skip-onboard"]').click()`);
      await wait(300);
    }

    await exec(win, `document.getElementById('newEntryBtn').click()`);
    await wait(500);
    await exec(win, `
      document.getElementById('fTitle').value = 'E2E 测试条目';
      document.getElementById('fUsername').value = 'e2e@test.local';
      document.getElementById('fPassword').value = 'T3st!Pass-2026';
      document.getElementById('fUrl').value = 'https://example.com';
      document.getElementById('fCategory').value = '服务器';
      document.getElementById('fNotes').value = '端到端测试写入';
      document.getElementById('entryForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await wait(1600);

    const rendered = await exec(win, `document.getElementById('entryList').innerText.includes('E2E 测试条目')`);
    if (!rendered) throw new Error('条目未出现在列表中');

    await wait(300);
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'shots', 'e2e-created.png'), image.toPNG());

    console.log('E2E-CREATE-OK');
    console.log('data dir:', process.env.KEYNEST_DATA_DIR);
  } catch (err) {
    console.error('E2E-CREATE-FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
