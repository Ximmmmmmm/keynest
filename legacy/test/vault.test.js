'use strict';

/**
 * 加密仓库与密码生成器的自测（直接运行 Node，不需要 Electron）
 *   node test/vault.test.js
 */

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Vault, VaultError } = require('../src/main/vault');
const { generatePassword, estimateStrength } = require('../src/main/password');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keynest-test-'));
  const file = path.join(dir, 'vault.dat');
  const MASTER = 'Correct-Horse-Battery-9!';

  console.log('\n[仓库加密]');

  await test('创建仓库并写入加密文件', async () => {
    const vault = new Vault(file);
    assert.strictEqual(await vault.exists(), false);
    const created = await vault.create(MASTER);
    assert.strictEqual(await vault.exists(), true);
    assert.strictEqual(created.settings.importPrompted, false);
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.format, 'keynest.v1');
    assert.strictEqual(parsed.kdf.algo, 'scrypt');
    assert.ok(parsed.kdf.salt.length > 10);
    const settings = await vault.updateSettings({ importPrompted: true });
    assert.strictEqual(settings.importPrompted, true);
    vault.lock();
  });

  await test('主密码错误时解密失败，正确时成功', async () => {
    const vault = new Vault(file);
    await assert.rejects(() => vault.unlock('wrong-password'), (err) => err.code === 'INVALID_PASSWORD');
    const snap = await vault.unlock(MASTER);
    assert.ok(Array.isArray(snap.entries));
    vault.lock();
    assert.strictEqual(vault.isUnlocked(), false);
  });

  await test('明文密码与标题不会出现在磁盘文件中', async () => {
    const vault = new Vault(file);
    await vault.unlock(MASTER);
    await vault.upsertEntry({
      title: 'GitHub-Dev',
      username: 'dev@example.com',
      password: 'SuperSecretValue-42',
      url: 'https://github.com',
      category: '网站',
      notes: '工单系统备注',
    });
    vault.lock();
    const raw = await fsp.readFile(file, 'utf8');
    for (const needle of ['GitHub-Dev', 'SuperSecretValue-42', 'dev@example.com', '工单系统备注', MASTER]) {
      assert.ok(!raw.includes(needle), `文件中出现了明文：${needle}`);
    }
  });

  await test('新增 / 编辑 / 删除条目并持久化', async () => {
    const vault = new Vault(file);
    let snap = await vault.unlock(MASTER);
    assert.strictEqual(snap.entries.length, 1);
    const entry = snap.entries[0];

    const updated = await vault.upsertEntry({ ...entry, title: 'GitHub-Main', password: 'NewPass-2026!' });
    assert.strictEqual(updated.id, entry.id);
    assert.strictEqual(updated.createdAt, entry.createdAt);

    const second = await vault.upsertEntry({ title: '邮箱', username: 'me@example.com', password: 'p@ss', category: '邮箱' });
    snap = vault.snapshot();
    assert.strictEqual(snap.entries.length, 2);
    assert.ok(snap.categories.includes('邮箱'));

    await vault.deleteEntry(second.id);
    snap = vault.snapshot();
    assert.strictEqual(snap.entries.length, 1);
    assert.strictEqual(snap.entries[0].title, 'GitHub-Main');
    vault.lock();

    const reopened = new Vault(file);
    const again = await reopened.unlock(MASTER);
    assert.strictEqual(again.entries[0].password, 'NewPass-2026!');
    reopened.lock();
  });

  await test('密文被篡改后无法解密', async () => {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    const bytes = Buffer.from(raw.payload, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    raw.payload = bytes.toString('base64');
    const tampered = path.join(dir, 'tampered.dat');
    await fsp.writeFile(tampered, JSON.stringify(raw), 'utf8');

    const vault = new Vault(tampered);
    await assert.rejects(() => vault.unlock(MASTER), (err) => err.code === 'INVALID_PASSWORD');
  });

  await test('KDF 参数被降级修改后无法解密（AAD 校验）', async () => {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    raw.kdf.N = 1 << 12;
    const downgraded = path.join(dir, 'downgraded.dat');
    await fsp.writeFile(downgraded, JSON.stringify(raw), 'utf8');

    const vault = new Vault(downgraded);
    await assert.rejects(() => vault.unlock(MASTER));
  });

  await test('修改主密码后旧密码失效、新密码可用，备份同步更新', async () => {
    const vault = new Vault(file);
    await vault.unlock(MASTER);
    await assert.rejects(() => vault.changeMasterPassword('wrong-old', 'Whatever-123!'), (err) => err.code === 'INVALID_PASSWORD');
    const NEW = 'Another-Passphrase-77#';
    await vault.changeMasterPassword(MASTER, NEW);
    vault.lock();

    const oldVault = new Vault(file);
    await assert.rejects(() => oldVault.unlock(MASTER), (err) => err.code === 'INVALID_PASSWORD');

    const newVault = new Vault(file);
    const snap = await newVault.unlock(NEW);
    assert.strictEqual(snap.entries.length, 1);
    newVault.lock();

    const bak = await fsp.access(file + '.bak').then(() => true, () => false);
    assert.ok(bak, '未生成备份文件');
    const bakVault = new Vault(file + '.bak');
    const bakSnap = await bakVault.unlock(NEW);
    assert.strictEqual(bakSnap.entries.length, 1);
    bakVault.lock();
  });

  await test('导出备份可被同一主密码打开', async () => {
    const vault = new Vault(file);
    await vault.unlock('Another-Passphrase-77#');
    const dest = path.join(dir, 'export.dat');
    await vault.exportBackup(dest);
    vault.lock();
    const copy = new Vault(dest);
    const snap = await copy.unlock('Another-Passphrase-77#');
    assert.strictEqual(snap.entries.length, 1);
    copy.lock();
  });

  await test('未解锁时拒绝读写', async () => {
    const vault = new Vault(file);
    await assert.rejects(() => vault.upsertEntry({ title: 'x' }), (err) => err.code === 'LOCKED');
    assert.throws(() => vault.snapshot(), (err) => err.code === 'LOCKED');
  });

  await test('空标题、超长字段被拒绝或截断', async () => {
    const vault = new Vault(file);
    await vault.unlock('Another-Passphrase-77#');
    await assert.rejects(() => vault.upsertEntry({ title: '   ' }), (err) => err.code === 'INVALID_ENTRY');
    const long = await vault.upsertEntry({ title: '长文本', notes: 'x'.repeat(9000) });
    assert.strictEqual(long.notes.length, 5000);
    await vault.deleteEntry(long.id);
    vault.lock();
  });

  await test('批量导入一次写入并跳过非法条目', async () => {
    const vault = new Vault(file);
    await vault.unlock('Another-Passphrase-77#');
    const before = vault.snapshot().entries.length;
    const res = await vault.importBatch({
      add: [
        { title: '导入 A', username: 'ua', password: 'pa', category: '网站' },
        { title: '导入 B', url: 'https://b.test', username: 'ub', password: 'pb' },
        { title: '', password: 'bad' },
      ],
      update: [{ id: 'missing', password: 'x' }],
    });
    assert.strictEqual(res.added, 2);
    assert.strictEqual(res.updated, 0);
    const snap = vault.snapshot();
    assert.strictEqual(snap.entries.length, before + 2);
    assert.ok(snap.categories.includes('网站'));
    vault.lock();
  });

  await test('清空仓库后文件与备份都被删除', async () => {
    const vault = new Vault(file);
    await vault.unlock('Another-Passphrase-77#');
    await vault.wipe();
    assert.strictEqual(await vault.exists(), false);
    assert.strictEqual(await fsp.access(file + '.bak').then(() => true, () => false), false);
  });

  console.log('\n[密码生成器]');

  await test('生成的密码符合长度与字符集要求', () => {
    for (let i = 0; i < 300; i += 1) {
      const pw = generatePassword({ length: 20, lower: true, upper: true, digits: true, symbols: true });
      assert.strictEqual(pw.length, 20);
      assert.ok(/[a-z]/.test(pw), '缺少小写');
      assert.ok(/[A-Z]/.test(pw), '缺少大写');
      assert.ok(/[0-9]/.test(pw), '缺少数字');
      assert.ok(/[^A-Za-z0-9]/.test(pw), '缺少符号');
      assert.ok(!/[0O1lI|`'"]/.test(pw), '未排除易混淆字符');
    }
  });

  await test('仅选择一种字符集时也能生成', () => {
    const pw = generatePassword({ length: 12, lower: true, upper: false, digits: false, symbols: false });
    assert.strictEqual(pw.length, 12);
    assert.ok(/^[a-z]+$/.test(pw));
  });

  await test('生成结果具备随机性（1000 次无重复）', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) seen.add(generatePassword({ length: 16 }));
    assert.strictEqual(seen.size, 1000);
  });

  await test('强度评估分级合理', () => {
    assert.ok(estimateStrength('123456').score <= 1);
    assert.ok(estimateStrength('aaaaaaaaaaaa').score <= 1);
    assert.ok(estimateStrength('Tr0ub4dor&3xK9pQz').score >= 3);
  });

  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
  if (failures.length) process.exitCode = 1;
})();
