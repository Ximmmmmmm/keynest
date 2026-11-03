'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog, Menu, session, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Vault } = require('./vault');
const { generatePassword, estimateStrength } = require('./password');
const { scanBrowsers, readBrowserProfile, itemsFromCsv, planImport } = require('./browser-import');
const csvDiscovery = require('./csv-discovery');
const exporter = require('./export');

const isDev = !app.isPackaged;
let mainWindow = null;
let vault = null;
let lastActivity = Date.now();
let lockTimer = null;
let clipboardTimer = null;
let clipboardValue = null;
let pendingCsv = null;

// 数据目录固定为 %APPDATA%\KeyNest：
// productName 是中文，若不显式指定，Electron 会生成含中文的 userData 路径。
// 便携 / 测试模式可用 KEYNEST_DATA_DIR 覆盖。
const dataDir = process.env.KEYNEST_DATA_DIR
  ? path.resolve(process.env.KEYNEST_DATA_DIR)
  : path.join(app.getPath('appData'), 'KeyNest');
app.setPath('userData', dataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId('com.keynest.app');

function vaultPath() {
  return path.join(app.getPath('userData'), 'vault.dat');
}

function currentSettings() {
  const s = vault && vault.data && vault.data.settings;
  return s || { autoLockMinutes: 5, clipboardClearSeconds: 30, revealSeconds: 20 };
}

function touch() {
  lastActivity = Date.now();
}

function lockVault(reason = 'manual') {
  if (!vault || !vault.isUnlocked()) return;
  vault.lock();
  pendingCsv = null; // 未完成的 CSV 明文不留在内存里
  clearClipboardNow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:locked', { reason });
  }
}

function startLockTimer() {
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (!vault || !vault.isUnlocked()) return;
    const limit = currentSettings().autoLockMinutes * 60 * 1000;
    if (Date.now() - lastActivity >= limit) lockVault('idle');
  }, 5000);
}

function clearClipboardNow() {
  if (clipboardTimer) {
    clearTimeout(clipboardTimer);
    clipboardTimer = null;
  }
  if (clipboardValue !== null) {
    try {
      if (clipboard.readText() === clipboardValue) clipboard.clear();
    } catch {
      /* 忽略剪贴板占用 */
    }
    clipboardValue = null;
  }
}

function copySensitive(text, sensitive) {
  const value = String(text ?? '');
  clearClipboardNow();
  clipboard.writeText(value);
  if (!sensitive) return { clearedIn: 0 };
  const seconds = currentSettings().clipboardClearSeconds;
  clipboardValue = value;
  if (seconds > 0) {
    clipboardTimer = setTimeout(() => {
      try {
        if (clipboard.readText() === value) clipboard.clear();
      } catch {
        /* ignore */
      }
      clipboardValue = null;
      clipboardTimer = null;
    }, seconds * 1000);
  }
  return { clearedIn: seconds };
}

const ok = (data) => ({ ok: true, data });
function fail(err) {
  const code = err && err.code ? err.code : 'UNEXPECTED';
  const message = err && err.message ? err.message : '发生未知错误';
  if (isDev && code === 'UNEXPECTED') console.error(err);
  return { ok: false, error: { code, message } };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, args) => {
    // 只接受来自主窗口的调用
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '非法调用来源' } };
    }
    try {
      const result = await fn(args || {});
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '导出加密备份…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: async () => {
            if (mainWindow) mainWindow.webContents.send('vault:command', { name: 'export' });
          },
        },
        { type: 'separator' },
        {
          label: '立即锁定',
          accelerator: 'CmdOrCtrl+L',
          click: () => lockVault('manual'),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 钥巢',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 钥巢',
              message: '钥巢 KeyNest 0.1.0',
              detail:
                '每把钥匙，都有归处。\n\n本地加密密码管理器\n\n加密：scrypt (N=2^17, r=8, p=1) + AES-256-GCM\n数据仅保存在本机，主密码从不写入磁盘。',
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#f4f5f9',
    title: '钥巢',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    });
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  vault = new Vault(vaultPath());
  buildMenu();
  createWindow();
  startLockTimer();

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (lockTimer) clearInterval(lockTimer);
  clearClipboardNow();
  if (vault) vault.lock();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  clearClipboardNow();
  if (vault) vault.lock();
});

/* ------------------------------ IPC ------------------------------ */

handle('vault:status', async () => ({
  exists: await vault.exists(),
  unlocked: vault.isUnlocked(),
  path: vaultPath(),
  version: app.getVersion(),
}));

handle('vault:create', async ({ password }) => {
  const snapshot = await vault.create(password);
  touch();
  return snapshot;
});

handle('vault:unlock', async ({ password }) => {
  const snapshot = await vault.unlock(password);
  touch();
  return snapshot;
});

handle('vault:lock', async () => {
  lockVault('manual');
  return true;
});

handle('vault:snapshot', async () => {
  touch();
  return vault.snapshot();
});

handle('vault:save-entry', async ({ entry }) => {
  touch();
  const saved = await vault.upsertEntry(entry);
  return { entry: saved, snapshot: vault.snapshot() };
});

handle('vault:delete-entry', async ({ id }) => {
  touch();
  await vault.deleteEntry(String(id || ''));
  return vault.snapshot();
});

handle('vault:add-category', async ({ name }) => {
  touch();
  await vault.addCategory(name);
  return vault.snapshot();
});

handle('vault:update-settings', async ({ patch }) => {
  touch();
  const settings = await vault.updateSettings(patch);
  return { settings, snapshot: vault.snapshot() };
});

handle('vault:change-master', async ({ oldPassword, newPassword }) => {
  await vault.changeMasterPassword(oldPassword, newPassword);
  touch();
  return true;
});

handle('vault:generate-password', async (options) => {
  const password = generatePassword(options || {});
  return { password, strength: estimateStrength(password) };
});

handle('vault:estimate-strength', async ({ password }) => estimateStrength(password));

handle('vault:copy', async ({ text, sensitive }) => copySensitive(text, !!sensitive));

handle('vault:export-backup', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出加密备份',
    defaultPath: `vault-backup-${stamp}.dat`,
    filters: [{ name: '加密仓库', extensions: ['dat'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await vault.exportBackup(filePath);
  return { canceled: false, path: filePath };
});

handle('vault:wipe', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '删除所有数据',
    message: '确定要永久删除整个密码库吗？',
    detail: '仓库文件与其备份将被删除，此操作不可撤销，且没有云端副本。',
    buttons: ['取消', '永久删除'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return { wiped: false };
  await vault.wipe();
  pendingCsv = null;
  return { wiped: true };
});

/* ---------------------- 浏览器密码导入 ---------------------- */

handle('browser:scan', async () => ({ sources: scanBrowsers() }));

/** 一键导入用：自动发现「刚导出的 CSV」，并把候选列表给界面 */
handle('browser:discover-csv', async () => {
  const result = csvDiscovery.discover();
  const brief = (item) => ({
    path: item.path,
    name: item.name,
    size: item.size,
    ageLabel: csvDiscovery.describeAge(item.ageMs),
    ageMs: item.ageMs,
  });
  return {
    found: result.found,
    confident: result.confident,
    truncated: result.truncated,
    scannedDirs: result.scannedDirs,
    files: result.files.map(brief),
    candidates: result.candidates.map(brief),
    file: result.file ? brief(result.file) : null,
  };
});

/** 解析单个 CSV 文件，返回条目（供批量导入复用） */
async function readCsvItems(filePath) {
  const target = path.resolve(String(filePath || ''));
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw Object.assign(new Error('找不到这个 CSV 文件'), { code: 'CSV_NOT_FOUND' });
  }
  if (!stat.isFile()) throw Object.assign(new Error('这不是一个文件'), { code: 'CSV_NOT_FOUND' });
  if (stat.size > 20 * 1024 * 1024) {
    throw Object.assign(new Error('CSV 文件过大（超过 20 MB）'), { code: 'FILE_TOO_LARGE' });
  }

  const text = await fsp.readFile(target, 'utf8');
  const { items, skippedRows } = itemsFromCsv(text);
  return { items, skippedRows, target };
}

/**
 * 一键导入：拿到 CSV（可多个）→ 解析 → 合并 → 一次性写入。
 *
 * 支持多文件是必须的：Chrome 和 Edge 各导一次会得到两个文件，
 * 用户期望的是「都导进来」，而不是只导一个。
 */
handle('browser:import-files', async ({ filePaths, mode }) => {
  const list = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  if (!list.length) {
    throw Object.assign(new Error('没有指定要导入的文件'), { code: 'CSV_NOT_FOUND' });
  }

  // 逐个解析；单个文件失败不影响其它文件
  const merged = [];
  const perFile = [];
  let totalSkippedRows = 0;

  for (const filePath of list) {
    try {
      const { items, skippedRows, target } = await readCsvItems(filePath);
      merged.push(...items);
      totalSkippedRows += skippedRows;
      perFile.push({ path: target, name: path.basename(target), count: items.length, error: null });
    } catch (err) {
      perFile.push({
        path: path.resolve(String(filePath)),
        name: path.basename(String(filePath)),
        count: 0,
        error: err && err.message ? err.message : '读取失败',
      });
    }
  }

  if (!merged.length) {
    throw Object.assign(new Error('这些 CSV 里都没有可导入的账号'), { code: 'CSV_EMPTY' });
  }

  const existing = vault.snapshot().entries;
  const plan = planImport(existing, merged, mode === 'overwrite' ? 'overwrite' : 'skip');
  const applied = await vault.importBatch({ add: plan.add, update: plan.update });
  touch();

  return {
    stats: {
      added: applied.added,
      updated: applied.updated,
      skipped: plan.skipped,
      invalid: plan.invalid,
      failed: plan.invalid,
      appBound: 0,
      total: merged.length,
      skippedRows: totalSkippedRows,
    },
    fileCount: perFile.length,
    perFile,
    fileName:
      perFile.length === 1 ? perFile[0].name : `${perFile.length} 个文件（${perFile.map((f) => f.name).join('、')}）`,
    filePaths: perFile.filter((f) => !f.error).map((f) => f.path),
    filePath: perFile.length === 1 ? perFile[0].path : null,
    snapshot: vault.snapshot(),
  };
});

/** 兼容旧调用：单文件导入 */
handle('browser:import-file', async ({ filePath, mode }) => {
  const target = path.resolve(String(filePath || ''));
  const text = await fsp.readFile(target, 'utf8');
  const { items, skippedRows } = itemsFromCsv(text);
  if (!items.length) {
    throw Object.assign(new Error('这个 CSV 里没有可导入的账号'), { code: 'CSV_EMPTY' });
  }

  const existing = vault.snapshot().entries;
  const plan = planImport(existing, items, mode === 'overwrite' ? 'overwrite' : 'skip');
  const applied = await vault.importBatch({ add: plan.add, update: plan.update });
  touch();

  return {
    stats: {
      added: applied.added,
      updated: applied.updated,
      skipped: plan.skipped,
      invalid: plan.invalid,
      failed: plan.invalid,
      appBound: 0,
      total: items.length,
      skippedRows,
    },
    fileName: path.basename(target),
    filePath: target,
    snapshot: vault.snapshot(),
  };
});

/** 导入完成后删除明文 CSV（支持批量） */
handle('browser:discard-csv', async ({ filePath, filePaths }) => {
  const list = Array.isArray(filePaths) ? filePaths : filePath ? [filePath] : [];
  const results = [];
  for (const item of list) {
    const target = path.resolve(String(item || ''));
    try {
      await fsp.unlink(target);
      results.push({ path: target, removed: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') results.push({ path: target, removed: false, reason: 'missing' });
      else results.push({ path: target, removed: false, reason: err && err.code ? err.code : 'failed' });
    }
  }
  return {
    removed: results.filter((r) => r.removed).length,
    total: results.length,
    results,
    // 单选兼容
    path: results[0] ? results[0].path : null,
  };
});

/* ---------------------- 明文导出 ---------------------- */

/**
 * 导出为 CSV / JSON（明文）。
 * 用户必须能把自己的数据带走 —— 这是密码管理器的基本契约。
 */
handle('vault:export-plain', async ({ format }) => {
  const kind = String(format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  const entries = vault.snapshot().entries;
  if (!entries.length) {
    throw Object.assign(new Error('仓库里还没有条目'), { code: 'VAULT_EMPTY' });
  }

  const suggested = exporter.suggestFileName(kind);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: kind === 'csv' ? '导出为 CSV（明文）' : '导出为 JSON（明文）',
    defaultPath: suggested,
    filters: [
      kind === 'csv'
        ? { name: 'CSV 文件', extensions: ['csv'] }
        : { name: 'JSON 文件', extensions: ['json'] },
    ],
  });
  if (canceled || !filePath) return { canceled: true };

  const content =
    kind === 'csv'
      ? exporter.toCsv(entries)
      : exporter.toJson(entries, { categories: vault.snapshot().categories });

  await fsp.writeFile(filePath, content, 'utf8');
  touch();
  return { canceled: false, path: filePath, count: entries.length, format: kind };
});

handle('browser:import', async ({ id, dir, mode }) => {
  const existing = vault.snapshot().entries;
  const result = readBrowserProfile(String(id || ''), String(dir || ''));
  const plan = planImport(existing, result.items, mode === 'overwrite' ? 'overwrite' : 'skip');
  const applied = await vault.importBatch({ add: plan.add, update: plan.update });
  touch();
  return {
    stats: {
      added: applied.added,
      updated: applied.updated,
      skipped: plan.skipped,
      invalid: plan.invalid,
      failed: result.failed,
      appBound: result.appBound,
      total: result.total,
    },
    snapshot: vault.snapshot(),
  };
});

handle('browser:pick-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择浏览器导出的 CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  if (canceled || !filePaths.length) return { canceled: true };

  const file = filePaths[0];
  const stat = await fsp.stat(file);
  if (stat.size > 20 * 1024 * 1024) {
    throw Object.assign(new Error('CSV 文件过大（超过 20 MB）'), { code: 'FILE_TOO_LARGE' });
  }

  const text = await fsp.readFile(file, 'utf8');
  const { items, skippedRows } = itemsFromCsv(text);
  if (!items.length) {
    throw Object.assign(new Error('这个 CSV 里没有可导入的账号'), { code: 'CSV_EMPTY' });
  }

  pendingCsv = { token: crypto.randomUUID(), items, fileName: path.basename(file), at: Date.now() };
  return {
    canceled: false,
    token: pendingCsv.token,
    count: items.length,
    skippedRows,
    fileName: pendingCsv.fileName,
  };
});

handle('browser:import-csv', async ({ token, mode }) => {
  if (!pendingCsv || pendingCsv.token !== token) {
    throw Object.assign(new Error('CSV 数据已失效，请重新选择文件'), { code: 'CSV_EXPIRED' });
  }
  if (Date.now() - pendingCsv.at > 10 * 60 * 1000) {
    pendingCsv = null;
    throw Object.assign(new Error('CSV 数据已过期，请重新选择文件'), { code: 'CSV_EXPIRED' });
  }

  const { items, fileName } = pendingCsv;
  pendingCsv = null;

  const existing = vault.snapshot().entries;
  const plan = planImport(existing, items, mode === 'overwrite' ? 'overwrite' : 'skip');
  const applied = await vault.importBatch({ add: plan.add, update: plan.update });
  touch();
  return {
    stats: {
      added: applied.added,
      updated: applied.updated,
      skipped: plan.skipped,
      invalid: plan.invalid,
      failed: plan.invalid,
      appBound: 0,
      total: items.length,
    },
    fileName,
    snapshot: vault.snapshot(),
  };
});

handle('vault:open-data-folder', async () => {
  shell.showItemInFolder(vaultPath());
  return true;
});

handle('vault:open-external', async ({ url }) => {
  const value = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('链接格式不正确'), { code: 'INVALID_URL' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw Object.assign(new Error('仅支持 http / https 链接'), { code: 'INVALID_URL' });
  }
  await shell.openExternal(parsed.toString());
  return true;
});

handle('vault:touch', async () => {
  touch();
  return true;
});
