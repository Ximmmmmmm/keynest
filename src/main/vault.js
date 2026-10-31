'use strict';

/**
 * 钥巢 KeyNest — 加密仓库核心（纯 Node，不依赖 Electron，可单独测试）
 *
 * 文件结构：
 *   {
 *     format: "keynest.v1",
 *     kdf:    { algo:"scrypt", N, r, p, salt },
 *     cipher: { algo:"aes-256-gcm", iv, tag },
 *     updatedAt,
 *     payload: base64( AES-256-GCM( JSON(数据) ) )
 *   }
 *
 * 主密码 ──scrypt(随机盐)──> 32 字节主密钥 ──AES-256-GCM──> payload
 * 密钥仅存在于内存；GCM 认证标签同时用于校验主密码与检测篡改。
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');

const FORMAT = 'keynest.v1';
const CIPHER_ALGO = 'aes-256-gcm';
const DEFAULT_KDF = { algo: 'scrypt', N: 1 << 17, r: 8, p: 1 };
const MAXMEM = 512 * 1024 * 1024;
const KEY_LEN = 32;
const MIN_MASTER_LEN = 8;

const DEFAULT_CATEGORIES = ['网站', '邮箱', '应用', '金融', '其他'];
const DEFAULT_SETTINGS = {
  autoLockMinutes: 5,
  clipboardClearSeconds: 30,
  revealSeconds: 20,
  importPrompted: false,
};

class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'VaultError';
    this.code = code;
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (str) => Buffer.from(String(str), 'base64');
const nowISO = () => new Date().toISOString();
const normPw = (pw) => String(pw == null ? '' : pw).normalize('NFC');

function deriveKey(masterPassword, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      normPw(masterPassword),
      salt,
      KEY_LEN,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, dk) => (err ? reject(err) : resolve(dk)),
    );
  });
}

/** 把头部信息绑定进 AAD：任何 KDF 参数被改写都会导致解密失败（防降级攻击） */
function aadOf(header) {
  const kdf = header.kdf || {};
  return Buffer.from(
    JSON.stringify({
      format: FORMAT,
      kdf: { algo: kdf.algo, N: kdf.N, r: kdf.r, p: kdf.p },
      salt: kdf.salt,
    }),
    'utf8',
  );
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function limitText(value, max) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function normalizeEntry(raw, existing) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const title = limitText(src.title, 200).trim();
  if (!title) throw new VaultError('INVALID_ENTRY', '标题不能为空');
  const ts = nowISO();
  return {
    id: existing ? existing.id : crypto.randomUUID(),
    title,
    username: limitText(src.username, 300),
    password: limitText(src.password, 1024),
    url: limitText(src.url, 500),
    category: limitText(src.category, 40).trim() || '其他',
    notes: limitText(src.notes, 5000),
    createdAt: existing ? existing.createdAt : ts,
    updatedAt: ts,
  };
}

function normalizeData(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const data = {
    version: 1,
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : nowISO(),
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : nowISO(),
    settings: Object.assign({}, DEFAULT_SETTINGS, src.settings && typeof src.settings === 'object' ? src.settings : {}),
    categories: Array.isArray(src.categories) ? src.categories.filter((c) => typeof c === 'string' && c.trim()).slice(0, 100) : DEFAULT_CATEGORIES.slice(),
    entries: [],
  };
  data.settings.autoLockMinutes = clampInt(data.settings.autoLockMinutes, 1, 240, 5);
  data.settings.clipboardClearSeconds = clampInt(data.settings.clipboardClearSeconds, 0, 300, 30);
  data.settings.revealSeconds = clampInt(data.settings.revealSeconds, 0, 300, 20);
  data.settings.importPrompted = data.settings.importPrompted === true;
  if (!data.categories.length) data.categories = DEFAULT_CATEGORIES.slice();
  if (Array.isArray(src.entries)) {
    data.entries = src.entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => {
        const ts = typeof e.updatedAt === 'string' ? e.updatedAt : nowISO();
        return {
          id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
          title: limitText(e.title, 200),
          username: limitText(e.username, 300),
          password: limitText(e.password, 1024),
          url: limitText(e.url, 500),
          category: limitText(e.category, 40) || '其他',
          notes: limitText(e.notes, 5000),
          createdAt: typeof e.createdAt === 'string' ? e.createdAt : ts,
          updatedAt: ts,
        };
      })
      .filter((e) => e.title);
  }
  return data;
}

class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null;
    this.header = null;
    this.data = null;
    this._saving = null;
  }

  get backupPath() {
    return this.filePath + '.bak';
  }

  async exists() {
    try {
      await fsp.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  isUnlocked() {
    return this.key !== null;
  }

  async create(masterPassword) {
    if (await this.exists()) throw new VaultError('ALREADY_EXISTS', '仓库已存在');
    if (normPw(masterPassword).length < MIN_MASTER_LEN) {
      throw new VaultError('WEAK_PASSWORD', `主密码至少 ${MIN_MASTER_LEN} 位`);
    }
    const salt = crypto.randomBytes(16);
    const kdf = { ...DEFAULT_KDF, salt: b64(salt) };
    const key = await deriveKey(masterPassword, salt, kdf);
    this.key = key;
    this.header = { format: FORMAT, kdf };
    this.data = normalizeData(null);
    await this.save();
    return this.snapshot();
  }

  async unlock(masterPassword) {
    let fileObj;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      fileObj = JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new VaultError('NO_VAULT', '尚未创建仓库');
      throw new VaultError('CORRUPT', '仓库文件无法解析，可能已损坏');
    }
    if (!fileObj || fileObj.format !== FORMAT || !fileObj.kdf || !fileObj.cipher || !fileObj.payload) {
      throw new VaultError('CORRUPT', '仓库文件格式不受支持');
    }

    const salt = unb64(fileObj.kdf.salt);
    const params = {
      N: clampInt(fileObj.kdf.N, 1 << 12, 1 << 20, DEFAULT_KDF.N),
      r: clampInt(fileObj.kdf.r, 1, 32, 8),
      p: clampInt(fileObj.kdf.p, 1, 16, 1),
    };
    const key = await deriveKey(masterPassword, salt, params);

    let plain;
    try {
      const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, unb64(fileObj.cipher.iv), {
        authTagLength: 16,
      });
      decipher.setAAD(aadOf(fileObj));
      decipher.setAuthTag(unb64(fileObj.cipher.tag));
      plain = Buffer.concat([decipher.update(unb64(fileObj.payload)), decipher.final()]).toString('utf8');
    } catch {
      key.fill(0);
      throw new VaultError('INVALID_PASSWORD', '主密码错误，或仓库文件已损坏');
    }

    this.key = key;
    this.header = { format: FORMAT, kdf: fileObj.kdf };
    try {
      this.data = normalizeData(JSON.parse(plain));
    } catch {
      // 解密成功但内容不是合法结构：立即清除密钥，避免半解锁状态
      key.fill(0);
      this.key = null;
      this.header = null;
      this.data = null;
      throw new VaultError('CORRUPT', '仓库内容已损坏，无法读取');
    }
    return this.snapshot();
  }

  lock() {
    if (this.key) {
      this.key.fill(0); // 尽力擦除密钥字节
      this.key = null;
    }
    this.header = null;
    this.data = null;
  }

  _requireUnlocked() {
    if (!this.key || !this.data) throw new VaultError('LOCKED', '仓库已锁定');
  }

  snapshot() {
    this._requireUnlocked();
    return {
      entries: structuredClone(this.data.entries),
      categories: structuredClone(this.data.categories),
      settings: structuredClone(this.data.settings),
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
    };
  }

  async save() {
    this._requireUnlocked();
    // 串行化写入，避免并发 save 互相覆盖
    const run = async () => {
      this.data.updatedAt = nowISO();
      const plain = Buffer.from(JSON.stringify(this.data), 'utf8');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(CIPHER_ALGO, this.key, iv, { authTagLength: 16 });
      cipher.setAAD(aadOf(this.header));
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();

      const fileObj = {
        format: FORMAT,
        kdf: this.header.kdf,
        cipher: { algo: CIPHER_ALGO, iv: b64(iv), tag: b64(tag) },
        updatedAt: this.data.updatedAt,
        payload: b64(enc),
      };
      const json = JSON.stringify(fileObj, null, 2);

      // 1) 备份上一版（同样是加密的）
      try {
        await fsp.copyFile(this.filePath, this.backupPath);
      } catch {
        /* 首次保存时没有旧文件 */
      }

      // 2) 写临时文件 → fsync → 原子替换
      const tmp = `${this.filePath}.tmp`;
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(json, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, this.filePath);
    };
    this._saving = (this._saving || Promise.resolve()).then(run, run);
    return this._saving;
  }

  async upsertEntry(input) {
    this._requireUnlocked();
    const existing = input && input.id ? this.data.entries.find((e) => e.id === input.id) : null;
    if (input && input.id && !existing) throw new VaultError('NOT_FOUND', '条目不存在');
    const entry = normalizeEntry(input, existing);
    if (existing) {
      this.data.entries = this.data.entries.map((e) => (e.id === entry.id ? entry : e));
    } else {
      this.data.entries.unshift(entry);
    }
    if (!this.data.categories.includes(entry.category)) this.data.categories.push(entry.category);
    await this.save();
    return entry;
  }

  async deleteEntry(id) {
    this._requireUnlocked();
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    if (this.data.entries.length === before) throw new VaultError('NOT_FOUND', '条目不存在');
    await this.save();
  }

  /**
   * 批量导入：一次性写入后只加密保存一次，避免几百条逐个 save。
   * add: 新条目数组；update: [{ id, password }] 覆盖已有条目的密码。
   */
  async importBatch({ add = [], update = [] } = {}) {
    this._requireUnlocked();
    let added = 0;
    let updated = 0;
    const seen = new Set(this.data.entries.map((e) => e.id));

    for (const input of add) {
      try {
        const entry = normalizeEntry(input, null);
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        this.data.entries.push(entry);
        if (!this.data.categories.includes(entry.category)) this.data.categories.push(entry.category);
        added += 1;
      } catch {
        // 单条不合法不影响整批导入
      }
    }

    for (const patch of update) {
      const target = this.data.entries.find((e) => e.id === patch.id);
      if (!target) continue;
      target.password = limitText(patch.password, 1024);
      target.updatedAt = nowISO();
      updated += 1;
    }

    if (added || updated) await this.save();
    return { added, updated };
  }

  async addCategory(name) {
    this._requireUnlocked();
    const value = String(name || '').trim().slice(0, 40);
    if (!value) throw new VaultError('INVALID_CATEGORY', '分类名不能为空');
    if (!this.data.categories.includes(value)) {
      this.data.categories.push(value);
      await this.save();
    }
    return value;
  }

  async updateSettings(patch) {
    this._requireUnlocked();
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.autoLockMinutes != null) {
      this.data.settings.autoLockMinutes = clampInt(p.autoLockMinutes, 1, 240, 5);
    }
    if (p.clipboardClearSeconds != null) {
      this.data.settings.clipboardClearSeconds = clampInt(p.clipboardClearSeconds, 0, 300, 30);
    }
    if (p.revealSeconds != null) {
      this.data.settings.revealSeconds = clampInt(p.revealSeconds, 0, 300, 20);
    }
    if (p.importPrompted != null) {
      this.data.settings.importPrompted = p.importPrompted === true;
    }
    await this.save();
    return structuredClone(this.data.settings);
  }

  async verifyMasterPassword(masterPassword) {
    this._requireUnlocked();
    const salt = unb64(this.header.kdf.salt);
    const params = { N: this.header.kdf.N, r: this.header.kdf.r, p: this.header.kdf.p };
    const key = await deriveKey(masterPassword, salt, params);
    const ok = key.length === this.key.length && crypto.timingSafeEqual(key, this.key);
    key.fill(0);
    return ok;
  }

  async changeMasterPassword(oldPassword, newPassword) {
    this._requireUnlocked();
    if (!(await this.verifyMasterPassword(oldPassword))) {
      throw new VaultError('INVALID_PASSWORD', '原主密码不正确');
    }
    if (normPw(newPassword).length < MIN_MASTER_LEN) {
      throw new VaultError('WEAK_PASSWORD', `主密码至少 ${MIN_MASTER_LEN} 位`);
    }
    const salt = crypto.randomBytes(16);
    const kdf = { ...DEFAULT_KDF, salt: b64(salt) };
    const newKey = await deriveKey(newPassword, salt, kdf);
    this.key.fill(0);
    this.key = newKey;
    this.header = { format: FORMAT, kdf };
    await this.save();
    // 备份文件也要用新密码重写，否则旧的 .bak 只有旧密码能打开
    await fsp.copyFile(this.filePath, this.backupPath).catch(() => {});
  }

  async exportBackup(destPath) {
    if (!(await this.exists())) throw new VaultError('NO_VAULT', '尚未创建仓库');
    await fsp.copyFile(this.filePath, destPath);
    return destPath;
  }

  async wipe() {
    this.lock();
    await fsp.rm(this.filePath, { force: true });
    await fsp.rm(this.backupPath, { force: true });
    await fsp.rm(`${this.filePath}.tmp`, { force: true });
  }
}

module.exports = {
  Vault,
  VaultError,
  FORMAT,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  DEFAULT_KDF,
  MIN_MASTER_LEN,
};
