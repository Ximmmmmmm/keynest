'use strict';

/**
 * 从本机 Chromium 系浏览器（Chrome / Edge / Brave / Chromium）导入账号密码，
 * 以及解析 Chrome / Edge / Firefox 导出的 CSV。
 *
 * Chromium 的密码存储：
 *   Login Data（SQLite） → password_value 为 v10/v11 + AES-256-GCM
 *   密钥来自 Local State 的 os_crypt.encrypted_key，经 Windows DPAPI 解出（仅当前用户可解）
 *
 * Firefox 使用 NSS 加密，Node 无现成实现，因此走 CSV。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

class ImportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ImportError';
    this.code = code;
  }
}

const LOCAL_APPDATA = process.env.LOCALAPPDATA || '';

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', root: path.join(LOCAL_APPDATA, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'Microsoft Edge', root: path.join(LOCAL_APPDATA, 'Microsoft', 'Edge', 'User Data') },
  { id: 'brave', name: 'Brave', root: path.join(LOCAL_APPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'chromium', name: 'Chromium', root: path.join(LOCAL_APPDATA, 'Chromium', 'User Data') },
];

const PROFILE_RE = /^(Default|Profile \d+)$/;

/* ---------------- 浏览器发现 ---------------- */

function profileDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((item) => item.isDirectory() && PROFILE_RE.test(item.name))
    .map((item) => item.name)
    .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)));
}

function scanBrowsers() {
  const sources = [];
  for (const browser of BROWSERS) {
    if (!browser.root || !fs.existsSync(browser.root)) continue;
    const profiles = [];
    for (const dir of profileDirs(browser.root)) {
      const dbPath = path.join(browser.root, dir, 'Login Data');
      if (!fs.existsSync(dbPath)) continue;
      let stats = { count: -1, appBound: 0, importable: 0 };
      try {
        stats = analyzeProfile(dbPath);
      } catch {
        /* 读不到时保留 -1，界面提示关闭浏览器 */
      }
      profiles.push({ dir, label: dir === 'Default' ? '默认配置' : dir, ...stats });
    }
    if (profiles.length) sources.push({ id: browser.id, name: browser.name, profiles });
  }
  return sources;
}

/**
 * 统计一个配置文件的密码版本，不解密：
 * v20 是 Chrome/Edge 127+ 的应用绑定加密，普通程序无法解密，只能走 CSV 导出。
 */
function analyzeProfile(dbPath) {
  return withDatabaseCopy(dbPath, (db) => {
    const rows = db.prepare('SELECT password_value FROM logins WHERE blacklisted_by_user = 0').all();
    let appBound = 0;
    let importable = 0;
    for (const row of rows) {
      const blob = row.password_value == null ? null : Buffer.from(row.password_value);
      if (!blob || !blob.length) continue;
      const prefix = blob.subarray(0, 3).toString('latin1');
      if (prefix === 'v20') appBound += 1;
      else importable += 1;
    }
    return { count: rows.length, appBound, importable };
  });
}

/**
 * 浏览器运行时数据库被占用，先复制一份快照（含 WAL）再读，避免锁库。
 */
function withDatabaseCopy(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-import-'));
  try {
    const target = path.join(tmp, 'Login Data');
    fs.copyFileSync(dbPath, target);
    for (const suffix of ['-wal', '-shm']) {
      const extra = dbPath + suffix;
      if (fs.existsSync(extra)) {
        try {
          fs.copyFileSync(extra, target + suffix);
        } catch {
          /* WAL 复制失败时退回主库内容 */
        }
      }
    }

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(target);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- 解密 ---------------- */

function readLocalStateKey(root) {
  const file = path.join(root, 'Local State');
  if (!fs.existsSync(file)) return null;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const encrypted = json && json.os_crypt && json.os_crypt.encrypted_key;
  if (!encrypted) return null;

  const buf = Buffer.from(String(encrypted), 'base64');
  if (buf.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new ImportError('UNSUPPORTED_KEY', '浏览器密钥格式不受支持（可能不是 Windows 版）');
  }
  return dpapiUnprotect(buf.subarray(5));
}

/** 通过 Windows DPAPI 以当前用户身份解开密钥（不需要管理员权限） */
function dpapiUnprotect(buffer) {
  const b64 = buffer.toString('base64');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new ImportError('DPAPI_FAILED', '密钥数据异常');

  const script =
    "Add-Type -AssemblyName System.Security; " +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

  let output;
  try {
    output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
  } catch {
    throw new ImportError('DPAPI_FAILED', '无法用当前 Windows 账户解开浏览器密钥');
  }

  const text = String(output).trim().split(/\r?\n/).pop() || '';
  const plain = Buffer.from(text, 'base64');
  if (!plain.length) throw new ImportError('DPAPI_FAILED', 'DPAPI 返回空密钥');
  return plain;
}

/**
 * v10/v11: [3B 前缀][12B nonce][密文][16B tag]，AES-256-GCM
 * v20: Chrome 127+ 的应用绑定加密，普通权限无法解密
 * 其它: 老版本直接是 DPAPI blob
 */
function decryptChromeValue(blob, key) {
  if (!blob || !blob.length) throw new ImportError('EMPTY', '空密码');
  const prefix = blob.subarray(0, 3).toString('latin1');

  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) throw new ImportError('KEY_MISSING', '缺少浏览器密钥');
    if (blob.length < 3 + 12 + 16) throw new ImportError('BAD_BLOB', '密文长度异常');
    const nonce = blob.subarray(3, 15);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(15, blob.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  if (prefix === 'v20') {
    throw new ImportError('APP_BOUND', '受 Chrome 应用绑定加密保护');
  }

  return dpapiUnprotect(blob).toString('utf8');
}

/**
 * 读取一个 Login Data 数据库。key 可为 null（仅老式 DPAPI 条目可用）。
 */
function readLoginDatabase(dbPath, key) {
  return withDatabaseCopy(dbPath, (db) => {
    const rows = db
      .prepare('SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0')
      .all();

    const items = [];
    let failed = 0;
    let appBound = 0;

    for (const row of rows) {
      const blob = row.password_value == null ? null : Buffer.from(row.password_value);
      if (!blob || !blob.length) {
        failed += 1;
        continue;
      }
      try {
        const password = decryptChromeValue(blob, key);
        const url = String(row.origin_url || '');
        items.push({
          title: hostOf(url) || '未命名',
          url,
          username: String(row.username_value || ''),
          password,
          category: '网站',
        });
      } catch (err) {
        if (err && err.code === 'APP_BOUND') appBound += 1;
        else failed += 1;
      }
    }

    return { items, failed, appBound, total: rows.length };
  });
}

function readBrowserProfile(id, dir) {
  const browser = BROWSERS.find((item) => item.id === id);
  if (!browser) throw new ImportError('UNKNOWN_BROWSER', '未知的浏览器');
  if (!PROFILE_RE.test(String(dir || ''))) throw new ImportError('INVALID_PROFILE', '配置文件参数不正确');

  const dbPath = path.join(browser.root, dir, 'Login Data');
  if (!fs.existsSync(dbPath)) throw new ImportError('NOT_FOUND', '找不到该配置文件的密码库');

  try {
    const key = readLocalStateKey(browser.root);
    const result = readLoginDatabase(dbPath, key);
    if (key) key.fill(0);
    return { ...result, browser: browser.name, profile: dir };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    if (err && ['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code)) {
      throw new ImportError('DB_LOCKED', '读取失败，请先关闭浏览器再试');
    }
    throw err;
  }
}

/* ---------------- CSV ---------------- */

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      /* 兼容 CRLF */
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const CSV_COLUMNS = {
  url: ['url', 'origin', 'website', 'login_uri', 'web site'],
  username: ['username', 'login', 'user', 'login_username'],
  password: ['password', 'pass', 'login_password'],
  name: ['name', 'title'],
};

function itemsFromCsv(source) {
  const text = String(source || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows = parseCsv(text, delimiter).filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!rows.length) return { items: [], skippedRows: 0 };

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const indexOf = (names) => header.findIndex((cell) => names.includes(cell));

  const iUrl = indexOf(CSV_COLUMNS.url);
  const iUser = indexOf(CSV_COLUMNS.username);
  const iPass = indexOf(CSV_COLUMNS.password);
  const iName = indexOf(CSV_COLUMNS.name);

  if (iPass < 0) throw new ImportError('CSV_HEADER', 'CSV 中找不到 password 列');

  const items = [];
  let skippedRows = 0;

  for (const row of rows.slice(1)) {
    const cell = (index) => (index >= 0 ? String(row[index] || '').trim() : '');
    const url = cell(iUrl);
    const username = cell(iUser);
    const password = cell(iPass);

    if (!password && !username) {
      skippedRows += 1;
      continue;
    }

    items.push({
      title: cell(iName) || hostOf(url) || '未命名',
      url,
      username,
      password,
      category: '网站',
    });
  }

  return { items, skippedRows };
}

/* ---------------- 去重与合并 ---------------- */

function hostOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function dedupeKey(entry) {
  const host = hostOf(entry.url);
  const user = String(entry.username || '').trim().toLowerCase();
  return `${host || String(entry.title || '').trim().toLowerCase()}|${user}`;
}

/**
 * 对比现有条目，决定新增 / 覆盖 / 跳过。
 * mode = 'skip' 保留原有密码；'overwrite' 用导入的密码覆盖。
 */
function planImport(existing, incoming, mode = 'skip') {
  const byKey = new Map();
  for (const entry of existing) byKey.set(dedupeKey(entry), entry);

  const add = [];
  const update = [];
  const seen = new Set();
  let skipped = 0;
  let invalid = 0;

  for (const raw of incoming) {
    const title = String(raw.title || '').trim() || hostOf(raw.url) || '未命名';
    const item = {
      title,
      url: String(raw.url || ''),
      username: String(raw.username || ''),
      password: String(raw.password || ''),
      category: raw.category || '网站',
    };

    if (!item.password && !item.username) {
      invalid += 1;
      continue;
    }

    const key = dedupeKey(item);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const hit = byKey.get(key);
    if (hit) {
      if (mode === 'overwrite' && item.password) update.push({ id: hit.id, password: item.password });
      else skipped += 1;
    } else {
      add.push(item);
    }
  }

  return { add, update, skipped, invalid };
}

module.exports = {
  ImportError,
  BROWSERS,
  scanBrowsers,
  analyzeProfile,
  readBrowserProfile,
  readLoginDatabase,
  readLocalStateKey,
  decryptChromeValue,
  parseCsv,
  itemsFromCsv,
  planImport,
  hostOf,
};
