'use strict';

/* 仅用于界面截图验证的假数据层，不参与正式运行 */

const { contextBridge } = require('electron');

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();

const snapshot = {
  createdAt: iso(60 * 24 * 90),
  updatedAt: iso(30),
  settings: { autoLockMinutes: 5, clipboardClearSeconds: 30, revealSeconds: 20 },
  categories: ['网站', '邮箱', '应用', '金融', '其他', '服务器'],
  entries: [
    {
      id: 'e1',
      title: 'GitHub',
      username: 'demo.dev@example.com',
      password: 'kR7#vQm2!xLp9@Wd',
      url: 'https://github.com',
      category: '网站',
      notes: '开启两步验证，恢复码保存在离线纸质备份中。',
      createdAt: iso(60 * 24 * 60),
      updatedAt: iso(24),
    },
    {
      id: 'e2',
      title: '腾讯云控制台',
      username: 'admin@example.com',
      password: 'Tcloud-2026!Aq7#z',
      url: 'https://console.cloud.tencent.com',
      category: '服务器',
      notes: '轻量应用服务器 2 台，到期日 2027-03-14。',
      createdAt: iso(60 * 24 * 40),
      updatedAt: iso(60 * 3),
    },
    {
      id: 'e3',
      title: 'QQ 邮箱',
      username: 'demo.user@example.com',
      password: 'mail-Passw0rd!77',
      url: 'https://mail.qq.com',
      category: '邮箱',
      notes: '',
      createdAt: iso(60 * 24 * 80),
      updatedAt: iso(60 * 26),
    },
    {
      id: 'e4',
      title: '招商银行',
      username: '6225 **** **** 8842',
      password: '8821',
      url: 'https://www.cmbchina.com',
      category: '金融',
      notes: '仅用于查询，不用于支付。',
      createdAt: iso(60 * 24 * 30),
      updatedAt: iso(60 * 24 * 3),
    },
    {
      id: 'e5',
      title: 'Steam',
      username: 'xim_plays',
      password: 'G4m3r!Steam#2024',
      url: 'https://store.steampowered.com',
      category: '应用',
      notes: '',
      createdAt: iso(60 * 24 * 20),
      updatedAt: iso(60 * 24 * 5),
    },
    {
      id: 'e6',
      title: 'NAS 管理后台',
      username: 'root',
      password: 'N4s@Home-Server-88',
      url: 'http://192.168.1.10:5000',
      category: '服务器',
      notes: '仅内网访问，需先连 VPN。',
      createdAt: iso(60 * 24 * 15),
      updatedAt: iso(60 * 24 * 7),
    },
    {
      id: 'e7',
      title: 'Notion',
      username: 'demo.workspace@example.com',
      password: 'N0tion!Workspace#9',
      url: 'https://www.notion.so',
      category: '应用',
      notes: '团队空间管理员。',
      createdAt: iso(60 * 24 * 10),
      updatedAt: iso(60 * 24 * 9),
    },
    {
      id: 'e8',
      title: '知乎',
      username: '138****6620',
      password: 'zhihu123456',
      url: 'https://www.zhihu.com',
      category: '网站',
      notes: '',
      createdAt: iso(60 * 24 * 8),
      updatedAt: iso(60 * 24 * 12),
    },
  ],
};

const ok = (data) => ({ ok: true, data });

contextBridge.exposeInMainWorld('vaultApi', {
  status: async () =>
    ok({
      exists: true,
      unlocked: false,
      path: 'C:\\Users\\Public\\AppData\\Roaming\\KeyNest\\vault.dat',
      version: '0.1.0',
    }),
  create: async () => ok(snapshot),
  unlock: async () => ok(snapshot),
  lock: async () => ok(true),
  snapshot: async () => ok(snapshot),
  saveEntry: async () => ok({ entry: snapshot.entries[0], snapshot }),
  deleteEntry: async () => ok(snapshot),
  addCategory: async () => ok(snapshot),
  updateSettings: async (patch) => {
    Object.assign(snapshot.settings, patch);
    return ok({ settings: snapshot.settings, snapshot });
  },
  changeMaster: async () => ok(true),
  generatePassword: async () =>
    ok({ password: 'q7#Vx2!Lm9@Rt4$Kw', strength: { score: 4, bits: 118, label: '很强' } }),
  estimateStrength: async () => ok({ score: 4, bits: 118, label: '很强' }),
  copy: async () => ok({ clearedIn: 30 }),
  exportBackup: async () => ok({ canceled: false, path: 'C:\\Users\\Public\\Desktop\\vault-backup.dat' }),
  wipe: async () => ok({ wiped: false }),
  openDataFolder: async () => ok(true),
  openExternal: async () => ok(true),
  scanBrowsers: async () =>
    ok({
      sources: [
        {
          id: 'chrome',
          name: 'Google Chrome',
          profiles: [{ dir: 'Default', label: '默认配置', count: 25, appBound: 0, importable: 25 }],
        },
        {
          id: 'edge',
          name: 'Microsoft Edge',
          profiles: [{ dir: 'Default', label: '默认配置', count: 82, appBound: 82, importable: 0 }],
        },
      ],
    }),
  importBrowser: async () =>
    ok({
      stats: { added: 20, updated: 3, skipped: 2, invalid: 0, failed: 0, appBound: 0, total: 25 },
      snapshot,
    }),
  pickCsv: async () => ok({ canceled: false, token: 'token-demo', count: 64, skippedRows: 2, fileName: 'passwords.csv' }),
  importCsv: async () =>
    ok({
      stats: { added: 60, updated: 2, skipped: 2, invalid: 0, failed: 0, appBound: 0, total: 64 },
      fileName: 'passwords.csv',
      snapshot,
    }),

  // 一键导入：模拟「Chrome 和 Edge 各导了一份」
  discoverCsv: async () =>
    ok({
      found: true,
      confident: true,
      truncated: false,
      scannedDirs: ['C:\\Users\\Public\\Downloads'],
      files: [
        {
          path: 'C:\\Users\\Public\\Downloads\\Chrome 密码.csv',
          name: 'Chrome 密码.csv',
          size: 8421,
          ageLabel: '2 分钟前',
          ageMs: 120000,
        },
        {
          path: 'C:\\Users\\Public\\Downloads\\Edge 密码.csv',
          name: 'Edge 密码.csv',
          size: 21500,
          ageLabel: '3 分钟前',
          ageMs: 180000,
        },
      ],
      candidates: [
        {
          path: 'C:\\Users\\Public\\Downloads\\Chrome 密码.csv',
          name: 'Chrome 密码.csv',
          size: 8421,
          ageLabel: '2 分钟前',
          ageMs: 120000,
        },
        {
          path: 'C:\\Users\\Public\\Downloads\\Edge 密码.csv',
          name: 'Edge 密码.csv',
          size: 21500,
          ageLabel: '3 分钟前',
          ageMs: 180000,
        },
      ],
      file: {
        path: 'C:\\Users\\Public\\Downloads\\Chrome 密码.csv',
        name: 'Chrome 密码.csv',
        size: 8421,
        ageLabel: '2 分钟前',
        ageMs: 120000,
      },
    }),
  importCsvFile: async () =>
    ok({
      stats: { added: 64, updated: 0, skipped: 0, invalid: 0, failed: 0, appBound: 0, total: 64, skippedRows: 2 },
      fileName: 'Chrome 密码.csv',
      filePath: 'C:\\Users\\Public\\Downloads\\Chrome 密码.csv',
      snapshot,
    }),
  importCsvFiles: async () =>
    ok({
      stats: { added: 64, updated: 0, skipped: 0, invalid: 0, failed: 0, appBound: 0, total: 64, skippedRows: 2 },
      fileCount: 2,
      perFile: [
        { path: 'C:\\Users\\Public\\Downloads\\Chrome 密码.csv', name: 'Chrome 密码.csv', count: 40, error: null },
        { path: 'C:\\Users\\Public\\Downloads\\Edge 密码.csv', name: 'Edge 密码.csv', count: 24, error: null },
      ],
      fileName: '2 个文件（Chrome 密码.csv、Edge 密码.csv）',
      filePaths: [
        'C:\\Users\\Public\\Downloads\\Chrome 密码.csv',
        'C:\\Users\\Public\\Downloads\\Edge 密码.csv',
      ],
      filePath: null,
      snapshot,
    }),
  discardCsv: async (paths) => {
    const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
    return ok({
      removed: list.length,
      total: list.length,
      results: list.map((p) => ({ path: p, removed: true })),
      path: list[0] || null,
    });
  },

  exportPlain: async (format) =>
    ok({ canceled: false, path: `C:\\Users\\Public\\Downloads\\keynest-demo.${format}`, count: 8, format }),
  touch: async () => ok(true),
  onLocked: () => () => {},
  onCommand: () => () => {},
});
