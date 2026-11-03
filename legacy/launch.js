'use strict';

/**
 * 启动器：绕开环境里可能存在的 ELECTRON_RUN_AS_NODE，
 * 保证 `npm start` / `npm run test:ui` 一定以 GUI 模式启动 Electron。
 */

delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('node:child_process');
const electronPath = require('electron');

const args = process.argv.slice(2);
const target = args.length ? args : ['.'];

const child = spawn(electronPath, target, {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('启动 Electron 失败：', err.message);
  process.exit(1);
});
