'use strict';

/* 端到端：首次创建密码库后应弹出浏览器导入引导，并能直接进入导入界面 */

process.env.KEYNEST_DATA_DIR = require('node:path').join(__dirname, 'e2e-onboard-data');

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

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
      document.getElementById('masterInput').value = 'Onboard-Master-2026!';
      document.getElementById('masterConfirm').value = 'Onboard-Master-2026!';
      document.getElementById('lockForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await wait(2600);

    const title = await exec(win, `document.querySelector('.modal h3')?.textContent || ''`);
    if (title !== '把浏览器里的密码带进来？') {
      throw new Error(`首次创建后未出现导入引导，实际标题：${title || '无'}`);
    }

    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'shots', 'e2e-onboard.png'), image.toPNG());

    await exec(win, `document.querySelector('[data-action="start-onboard"]').click()`);
    await wait(900);

    const importTitle = await exec(win, `document.querySelector('.modal h3')?.textContent || ''`);
    if (importTitle !== '导入浏览器密码') {
      throw new Error(`未能从引导进入导入界面，实际标题：${importTitle || '无'}`);
    }

    const error = await exec(win, `document.querySelector('#importError')?.textContent || ''`);
    if (error) throw new Error(`导入界面报错：${error}`);

    const sourceCount = await exec(win, `document.querySelectorAll('.import-source').length`);
    console.log('E2E-ONBOARD-OK | 引导出现，已进入导入界面，检测到来源数：', sourceCount);
  } catch (err) {
    console.error('E2E-ONBOARD-FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
