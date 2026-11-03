'use strict';

/* 仅用于开发期视觉验证：electron test/ui-shot.js */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();

const outDir = path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(win) {
  await wait(260);
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))',
  );
  await wait(120);
}

async function shot(win, name) {
  await settle(win);
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  fs.writeFileSync(path.join(outDir, `${name}.png`), png);
  console.log(`saved ${name} (${png.length} bytes)`);
}

async function click(win, selector) {
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: true,
    backgroundColor: '#f3f4f9',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.focus();
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await wait(900);
  await shot(win, '01-lock');

  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('masterInput');
      input.value = 'demo-password';
      document.getElementById('lockForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })();
  `);
  await wait(700);
  await shot(win, '02-main');

  await click(win, '#newEntryBtn');
  await shot(win, '03-editor');

  await click(win, '[data-action="open-generator"]');
  await shot(win, '04-generator');

  await click(win, '[data-action="close-modal"]');
  await shot(win, '05-editor-return');

  await click(win, '[data-action="close-modal"]');
  await shot(win, '06-after-editor');

  await click(win, '[data-action="settings"]');
  await shot(win, '07-settings');

  await click(win, '[data-action="import-browser"]');
  await wait(400);
  await shot(win, '07b-import');

  // 主路径：一键导入
  await click(win, '[data-action="quick-import"]');
  await wait(400);
  await shot(win, '07c-import-result');

  // 确认「删掉 CSV」按钮出现并可点
  await click(win, '[data-action="discard-csv"]');
  await wait(250);
  await shot(win, '07d-import-discarded');

  await click(win, '[data-action="close-modal"]');
  await wait(200);
  await click(win, '[data-action="close-modal"]');
  await wait(200);

  win.setSize(1180, 800);
  await wait(400);
  await shot(win, '08-medium');

  win.setSize(940, 780);
  await wait(400);
  await shot(win, '09-narrow');

  win.setSize(760, 720);
  await wait(400);
  await shot(win, '10-narrow-list');
  await click(win, '[data-action="drawer"]');
  await shot(win, '11-drawer');

  await click(win, '[data-action="close-drawer"]');
  await wait(400);
  await click(win, '.entry');
  await shot(win, '12-narrow-detail');

  await click(win, '[data-action="edit"]');
  await shot(win, '13-edit-prefilled');
  await click(win, '[data-action="close-modal"]');

  await click(win, '[data-action="delete"]');
  await shot(win, '14-confirm-delete');

  app.quit();
});
