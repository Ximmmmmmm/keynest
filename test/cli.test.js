'use strict';

/**
 * CLI 导入的单元测试。
 *
 * 覆盖：参数解析、CSV 定位、主密码来源、去重/覆盖语义、dry-run 不落盘、错误路径。
 * 全部使用临时目录，不接触真实仓库与真实浏览器数据。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Vault } = require('../src/main/vault');
const cli = require('../src/cli/keynest-cli');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const MASTER = 'cli-test-master-12345';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keynest-cli-'));
}

async function seedVault(dir, entries = []) {
  const vault = new Vault(path.join(dir, 'vault.dat'));
  await vault.create(MASTER);
  for (const entry of entries) await vault.upsertEntry(entry);
  vault.lock();
  return path.join(dir, 'vault.dat');
}

function writeCsv(dir, name, rows) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.join('\n') + '\n', 'utf8');
  return file;
}

function withEnv(name, value, fn) {
  const before = process.env[name];
  process.env[name] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
}

(async () => {
  console.log('\n[参数解析]');

  await test('解析 --key value 与 --key=value', () => {
    const a = cli.parseArgs(['import', '--csv', 'a.csv', '--mode=overwrite', '--dry-run']);
    assert.strictEqual(a._[0], 'import');
    assert.strictEqual(a.csv, 'a.csv');
    assert.strictEqual(a.mode, 'overwrite');
    assert.strictEqual(a['dry-run'], true);
  });

  await test('布尔开关不会吞掉后面的值', () => {
    const a = cli.parseArgs(['--dry-run', '--csv', 'b.csv']);
    assert.strictEqual(a['dry-run'], true);
    assert.strictEqual(a.csv, 'b.csv');
  });

  console.log('\n[CSV 定位]');

  await test('默认候选目录包含下载目录', () => {
    const dirs = cli.defaultCsvDirs();
    assert.ok(dirs.some((d) => /Downloads$/i.test(d)), `dirs=${dirs.join(',')}`);
  });

  await test('取最近修改的 CSV', () => {
    const dir = tmpDir();
    try {
      const oldFile = writeCsv(dir, 'old.csv', ['name,url,username,password']);
      const newFile = writeCsv(dir, 'new.csv', ['name,url,username,password']);
      // 明确拉开两分钟的修改时间，避免同毫秒创建导致排序不确定
      const older = Date.now() / 1000 - 600;
      const newer = Date.now() / 1000 - 120;
      fs.utimesSync(oldFile, older, older);
      fs.utimesSync(newFile, newer, newer);

      const latest = cli.findLatestCsv([dir], { minAgeMs: 0 });
      assert.ok(latest, '应当找到 CSV');
      assert.strictEqual(path.basename(latest.path), 'new.csv');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('目录里没有 CSV 时返回 null', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      assert.strictEqual(cli.findLatestCsv([dir]), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log('\n[主密码来源]');

  await test('--password-env 从环境变量读取', async () => {
    await withEnv('KN_TEST_PW', 'from-env', async () => {
      const pw = await cli.resolveMasterPassword({ 'password-env': 'KN_TEST_PW' });
      assert.strictEqual(pw, 'from-env');
    });
  });

  await test('环境变量缺失时报 PASSWORD_ENV_MISSING', async () => {
    await assert.rejects(
      () => cli.resolveMasterPassword({ 'password-env': 'KN_NOT_SET_XYZ' }),
      (err) => err.code === 'PASSWORD_ENV_MISSING',
    );
  });

  await test('非交互终端下拒绝隐式交互', async () => {
    // 测试进程的 stdin 不是 TTY
    await assert.rejects(
      () => cli.resolveMasterPassword({}),
      (err) => err.code === 'PASSWORD_NO_TTY',
    );
  });

  console.log('\n[导入语义]');

  await test('skip 模式：新增新条目，跳过已有账号', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, [
        { title: 'github.com', url: 'https://github.com', username: 'alice', password: 'old-pass' },
      ]);
      writeCsv(dir, 'e.csv', [
        'name,url,username,password',
        'GitHub,https://github.com,Alice,new-pass',
        'Fresh,https://fresh.test,u,p1',
      ]);

      const result = await withEnv('KN_PW', MASTER, () =>
        cli.commandImport({
          csv: path.join(dir, 'e.csv'),
          'data-dir': dir,
          mode: 'skip',
          'password-env': 'KN_PW',
        }),
      );

      assert.strictEqual(result.added, 1, '应新增 1 条');
      assert.strictEqual(result.updated, 0, 'skip 模式不更新');
      assert.strictEqual(result.skipped, 1, '已有账号应跳过');

      const vault = new Vault(path.join(dir, 'vault.dat'));
      await vault.unlock(MASTER);
      const byTitle = new Map(vault.snapshot().entries.map((e) => [e.title, e]));
      assert.strictEqual(byTitle.get('github.com').password, 'old-pass', 'skip 不应改密码');
      assert.ok(byTitle.has('Fresh'));
      vault.lock();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('overwrite 模式：覆盖同账号密码', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, [
        { title: 'github.com', url: 'https://github.com', username: 'alice', password: 'old-pass' },
      ]);
      writeCsv(dir, 'e.csv', ['name,url,username,password', 'GitHub,https://github.com,alice,new-pass']);

      const result = await withEnv('KN_PW', MASTER, () =>
        cli.commandImport({
          csv: path.join(dir, 'e.csv'),
          'data-dir': dir,
          mode: 'overwrite',
          'password-env': 'KN_PW',
        }),
      );
      assert.strictEqual(result.updated, 1);

      const vault = new Vault(path.join(dir, 'vault.dat'));
      await vault.unlock(MASTER);
      assert.strictEqual(vault.snapshot().entries[0].password, 'new-pass');
      vault.lock();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('dry-run 只统计不落盘', async () => {
    const dir = tmpDir();
    try {
      const vaultPath = await seedVault(dir, []);
      const before = fs.readFileSync(vaultPath);
      writeCsv(dir, 'e.csv', ['name,url,username,password', 'A,https://a.test,u,p']);

      const result = await withEnv('KN_PW', MASTER, () =>
        cli.commandImport({
          csv: path.join(dir, 'e.csv'),
          'data-dir': dir,
          'dry-run': true,
          'password-env': 'KN_PW',
        }),
      );

      assert.strictEqual(result.added, 1, '预演应报告 1 条待新增');
      assert.strictEqual(result.dryRun, true);
      const after = fs.readFileSync(vaultPath);
      assert.ok(before.equals(after), '预演不应修改仓库文件');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('重复导入是幂等的', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, []);
      writeCsv(dir, 'e.csv', ['name,url,username,password', 'A,https://a.test,u,p']);

      const run = () =>
        withEnv('KN_PW', MASTER, () =>
          cli.commandImport({
            csv: path.join(dir, 'e.csv'),
            'data-dir': dir,
            'password-env': 'KN_PW',
          }),
        );

      const first = await run();
      const second = await run();
      assert.strictEqual(first.added, 1);
      assert.strictEqual(second.added, 0, '第二次不应重复新增');
      assert.strictEqual(second.skipped, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log('\n[错误路径]');

  await test('CSV 不存在时给出 CSV_NOT_FOUND', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, []);
      await assert.rejects(
        () =>
          withEnv('KN_PW', MASTER, () =>
            cli.commandImport({
              csv: path.join(dir, 'nope.csv'),
              'data-dir': dir,
              'password-env': 'KN_PW',
            }),
          ),
        (err) => err.code === 'CSV_NOT_FOUND',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('仓库不存在时给出 NO_VAULT', async () => {
    const dir = tmpDir();
    try {
      writeCsv(dir, 'e.csv', ['name,url,username,password', 'A,https://a.test,u,p']);
      await assert.rejects(
        () =>
          withEnv('KN_PW', MASTER, () =>
            cli.commandImport({
              csv: path.join(dir, 'e.csv'),
              'data-dir': dir,
              'password-env': 'KN_PW',
            }),
          ),
        (err) => err.code === 'NO_VAULT',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('主密码错误时给出 INVALID_PASSWORD', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, []);
      writeCsv(dir, 'e.csv', ['name,url,username,password', 'A,https://a.test,u,p']);
      await assert.rejects(
        () =>
          withEnv('KN_PW', 'definitely-wrong', () =>
            cli.commandImport({
              csv: path.join(dir, 'e.csv'),
              'data-dir': dir,
              'password-env': 'KN_PW',
            }),
          ),
        (err) => err.code === 'INVALID_PASSWORD',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('CSV 只有表头时给出 CSV_EMPTY', async () => {
    const dir = tmpDir();
    try {
      await seedVault(dir, []);
      writeCsv(dir, 'e.csv', ['name,url,username,password']);
      await assert.rejects(
        () =>
          withEnv('KN_PW', MASTER, () =>
            cli.commandImport({
              csv: path.join(dir, 'e.csv'),
              'data-dir': dir,
              'password-env': 'KN_PW',
            }),
          ),
        (err) => err.code === 'CSV_EMPTY',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n结果：${passed} 通过，${failures.length} 失败\n`);
  if (failures.length) process.exitCode = 1;
})();
