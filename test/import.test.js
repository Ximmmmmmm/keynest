'use strict';

/**
 * 浏览器导入的单元测试：CSV、AES-GCM 解密、去重策略、SQLite 读取。
 * 使用合成数据，不接触本机真实密码。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  decryptChromeValue,
  analyzeProfile,
  parseCsv,
  itemsFromCsv,
  planImport,
  hostOf,
  readLoginDatabase,
} = require('../src/main/browser-import');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function makeV10(password, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()]);
}

console.log('\n[CSV 解析]');

test('处理引号、逗号、转义引号与 CRLF', () => {
  const csv = '\uFEFFname,url,username,password,note\r\nGitHub,https://github.com,alice,"p,a""ss",hi\r\n';
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'GitHub');
  assert.strictEqual(items[0].password, 'p,a"ss');
  assert.strictEqual(items[0].url, 'https://github.com');
});

test('引号内换行不会被拆行', () => {
  const csv = 'name,url,username,password\nX,https://x.test,u,"line1\nline2"\n';
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].password, 'line1\nline2');
});

test('识别 Firefox 导出格式', () => {
  const csv =
    'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\n' +
    'https://mail.qq.com,bob,secret,,,guid-1,1,2,3\n';
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'mail.qq.com');
  assert.strictEqual(items[0].username, 'bob');
});

test('支持分号分隔与空行', () => {
  const csv = 'name;url;username;password\nX;https://x.test;u;p\n\n';
  const { items } = itemsFromCsv(csv);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].password, 'p');
});

test('缺少 password 列时明确报错', () => {
  assert.throws(
    () => itemsFromCsv('name,url,username\nX,https://x.test,u\n'),
    (err) => err.code === 'CSV_HEADER',
  );
});

test('parseCsv 基础行为', () => {
  const rows = parseCsv('a,b\n1,2\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});

console.log('\n[密码解密]');

const KEY = crypto.randomBytes(32);

test('v10 使用 AES-256-GCM 正确解密', () => {
  const blob = makeV10('S3cret!密码', KEY);
  assert.strictEqual(decryptChromeValue(blob, KEY), 'S3cret!密码');
});

test('密文被篡改时解密失败', () => {
  const blob = makeV10('S3cret!', KEY);
  blob[blob.length - 20] ^= 0x01;
  assert.throws(() => decryptChromeValue(blob, KEY));
});

test('v20 应用绑定加密给出明确错误', () => {
  assert.throws(
    () => decryptChromeValue(Buffer.concat([Buffer.from('v20'), crypto.randomBytes(40)]), KEY),
    (err) => err.code === 'APP_BOUND',
  );
});

test('缺少密钥时明确报错', () => {
  assert.throws(() => decryptChromeValue(makeV10('x', KEY), null), (err) => err.code === 'KEY_MISSING');
});

console.log('\n[去重与合并]');

const existing = [
  { id: 'e1', title: 'GitHub', url: 'https://github.com', username: 'alice', password: 'old-pass' },
];
const incoming = [
  { title: 'github.com', url: 'https://www.github.com/', username: 'Alice', password: 'new-pass' },
  { title: 'New Site', url: 'https://new.test', username: 'u', password: 'p1' },
  { title: 'New Site dup', url: 'https://new.test/', username: 'U', password: 'p2' },
];

test('skip 模式：已有账号跳过，新增去重', () => {
  const plan = planImport(existing, incoming, 'skip');
  assert.strictEqual(plan.add.length, 1);
  assert.strictEqual(plan.update.length, 0);
  assert.strictEqual(plan.skipped, 2);
});

test('overwrite 模式：覆盖同一账号的密码', () => {
  const plan = planImport(existing, incoming, 'overwrite');
  assert.strictEqual(plan.add.length, 1);
  assert.deepStrictEqual(plan.update, [{ id: 'e1', password: 'new-pass' }]);
});

test('忽略既没有账号也没有密码的行', () => {
  const plan = planImport([], [{ title: 'x', url: '', username: '', password: '' }]);
  assert.strictEqual(plan.invalid, 1);
  assert.strictEqual(plan.add.length, 0);
});

test('URL 归一化去掉 www 与协议差异', () => {
  assert.strictEqual(hostOf('https://www.GitHub.com/login'), 'github.com');
  assert.strictEqual(hostOf('github.com'), 'github.com');
});

console.log('\n[SQLite 读取]');

test('从合成 Login Data 中解出条目并跳过黑名单', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-dbtest-'));
  const dbPath = path.join(dir, 'Login Data');
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER DEFAULT 0)',
    );
    const insert = db.prepare(
      'INSERT INTO logins (origin_url, username_value, password_value, blacklisted_by_user) VALUES (?, ?, ?, ?)',
    );
    insert.run('https://github.com/login', 'alice@example.com', makeV10('T3st!pass', KEY), 0);
    insert.run('https://ignored.test', 'bob', makeV10('nope', KEY), 1);
    insert.run('https://empty.test', 'carol', Buffer.alloc(0), 0);
    insert.run(
      'https://bound.test',
      'dave',
      Buffer.concat([Buffer.from('v20'), crypto.randomBytes(40)]),
      0,
    );
    db.close();

    const result = readLoginDatabase(dbPath, KEY);
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.items[0].password, 'T3st!pass');
    assert.strictEqual(result.items[0].title, 'github.com');
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.appBound, 1);
    assert.strictEqual(result.total, 3);

    const stats = analyzeProfile(dbPath);
    assert.deepStrictEqual(stats, { count: 3, appBound: 1, importable: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
if (failures.length) process.exitCode = 1;
