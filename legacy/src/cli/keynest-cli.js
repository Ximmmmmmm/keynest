'use strict';

/**
 * 钥巢 KeyNest — 命令行导入工具
 *
 * 用途：把「浏览器导出密码」变成一条命令完成的自动化流程。
 *
 * 为什么不直接读浏览器数据库：
 *   Chrome 127+ / Edge 127+ 默认用应用绑定加密（v20）保存密码，密钥交给浏览器的
 *   elevation_service（LocalSystem 服务）保管，服务只对镜像路径位于浏览器安装目录、
 *   且通过签名/路径校验的调用方解密。第三方程序拿到的是服务端的拒绝码，这是浏览器的
 *   设计而不是可绕过的缺陷。浏览器自带的「导出密码」是官方通道，导出时系统会要求
 *   Windows Hello 或账户密码，本身就是一道确认。
 *
 * 因此本工具的定位是：把「导出后的 CSV → 加密仓库」这最后一步做到可脚本化、可重复执行。
 *
 * 用法：
 *   node legacy/src/cli/keynest-cli.js import [options]
 *   node legacy/src/cli/keynest-cli.js scan
 *   node legacy/src/cli/keynest-cli.js export-template   （打印各浏览器的导出操作路径）
 *
 * 主密码来源（按优先级）：
 *   --password-env NAME      从环境变量读
 *   --password-stdin         从标准输入读一行（适合管道）
 *   交互式隐藏输入            以上都没有时提示输入
 * 主密码不接受命令行明文，避免进入 shell 历史与进程列表。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const { Vault, VaultError } = require('../main/vault');
const { itemsFromCsv, planImport, scanBrowsers } = require('../main/browser-import');

const DEFAULT_DATA_DIR = process.env.KEYNEST_DATA_DIR
  ? path.resolve(process.env.KEYNEST_DATA_DIR)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'KeyNest');

const MAX_CSV_BYTES = 20 * 1024 * 1024;

/* ---------------------------- 参数解析 ---------------------------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function flagBool(args, name) {
  const value = args[name];
  if (value === undefined) return false;
  if (value === true) return true;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}
/* ---------------------------- 主密码读取 ---------------------------- */

function readPasswordFromEnv(name) {
  const value = process.env[name];
  if (value === undefined) {
    throw Object.assign(new Error(`环境变量 ${name} 未设置`), { code: 'PASSWORD_ENV_MISSING' });
  }
  return value;
}

function readLineFromStdin() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let done = false;
    rl.once('line', (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!done) reject(Object.assign(new Error('标准输入没有读到主密码'), { code: 'PASSWORD_STDIN_EMPTY' }));
    });
    rl.on('error', reject);
  });
}

/** 交互式隐藏输入：不回显字符，避免主密码出现在终端里 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(Object.assign(new Error('当前不是交互终端，请用 --password-env 或 --password-stdin'), {
        code: 'PASSWORD_NO_TTY',
      }));
      return;
    }

    const stdin = process.stdin;
    let value = '';

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

async function resolveMasterPassword(args) {
  if (typeof args['password-env'] === 'string') return readPasswordFromEnv(args['password-env']);
  if (flagBool(args, 'password-stdin')) return readLineFromStdin();
  return promptHidden('主密码：');
}

/* ---------------------------- CSV 定位 ---------------------------- */

/**
 * 在若干候选目录里找最近修改的 .csv（浏览器导出默认落在「下载」）。
 * minAgeMs 只用于排除「正在写入」的文件；默认 0 表示不做额外等待，
 * 因为浏览器导出完成时文件已经关闭，卡太久反而会让刚导出的文件被忽略。
 */
function findLatestCsv(dirs, { minAgeMs = 0 } = {}) {
  const candidates = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.csv$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.size === 0 || stat.size > MAX_CSV_BYTES) continue;
        candidates.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  candidates.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    // mtime 相同时按文件名排序，保证结果稳定可复现
    return a.path.localeCompare(b.path);
  });
  const now = Date.now();
  const fresh = candidates.filter((item) => now - item.mtimeMs >= minAgeMs);
  return fresh[0] || candidates[0] || null;
}

function defaultCsvDirs() {
  const home = os.homedir();
  const list = [];
  const push = (dir) => {
    if (dir && !list.includes(dir)) list.push(dir);
  };
  push(path.join(home, 'Downloads'));
  push(path.join(home, 'Desktop'));
  push(path.join(home, 'Documents'));
  push(process.cwd());
  return list;
}

/* ---------------------------- 导入核心 ---------------------------- */

function readCsvFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw Object.assign(new Error('CSV 是空文件'), { code: 'CSV_EMPTY' });
  if (stat.size > MAX_CSV_BYTES) {
    throw Object.assign(new Error('CSV 文件过大（超过 20 MB）'), { code: 'FILE_TOO_LARGE' });
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const { items, skippedRows } = itemsFromCsv(text);
  if (!items.length) throw Object.assign(new Error('这个 CSV 里没有可导入的账号'), { code: 'CSV_EMPTY' });
  return { items, skippedRows, size: stat.size };
}

async function commandImport(args) {
  const dataDir = args['data-dir'] ? path.resolve(String(args['data-dir'])) : DEFAULT_DATA_DIR;
  const vaultPath = path.join(dataDir, 'vault.dat');

  let csvPath = typeof args.csv === 'string' ? path.resolve(args.csv) : null;
  if (!csvPath) {
    const dirs = args.dir ? [path.resolve(String(args.dir))] : defaultCsvDirs();
    const latest = findLatestCsv(dirs);
    if (!latest) {
      throw Object.assign(new Error('没有找到任何 CSV，请用 --csv 指定文件'), { code: 'CSV_NOT_FOUND' });
    }
    csvPath = latest.path;
  }

  if (!fs.existsSync(csvPath)) {
    throw Object.assign(new Error(`CSV 不存在：${csvPath}`), { code: 'CSV_NOT_FOUND' });
  }

  if (!fs.existsSync(vaultPath)) {
    throw Object.assign(new Error(`仓库不存在：${vaultPath}（请先启动一次应用创建主密码）`), {
      code: 'NO_VAULT',
    });
  }

  const password = await resolveMasterPassword(args);

  const vault = new Vault(vaultPath);
  try {
    await vault.unlock(password);

    const { items, skippedRows } = readCsvFile(csvPath);
    const mode = String(args.mode || 'skip').toLowerCase() === 'overwrite' ? 'overwrite' : 'skip';
    const existing = vault.snapshot().entries;
    const plan = planImport(existing, items, mode);

    const dryRun = flagBool(args, 'dry-run');
    // importBatch 的入参是 { add, update }，直接传 planImport 的结果即可
    const result = dryRun ? { added: 0, updated: 0 } : await vault.importBatch(plan);

    return {
      file: csvPath,
      mode,
      dryRun,
      parsed: items.length,
      skippedRows,
      added: dryRun ? plan.add.length : result.added,
      updated: dryRun ? plan.update.length : result.updated,
      skipped: plan.skipped,
      invalid: plan.invalid,
      totalBefore: existing.length,
      totalAfter: dryRun ? existing.length : vault.snapshot().entries.length,
    };
  } finally {
    vault.lock();
  }
}

function commandScan() {
  const sources = scanBrowsers();
  const summary = sources.map((source) => ({
    id: source.id,
    name: source.name,
    profiles: source.profiles.map((p) => ({
      dir: p.dir,
      total: p.count,
      importable: p.importable,
      appBound: p.appBound,
    })),
  }));
  const importable = summary.reduce(
    (sum, s) => sum + s.profiles.reduce((acc, p) => acc + Math.max(0, p.importable || 0), 0),
    0,
  );
  const appBound = summary.reduce(
    (sum, s) => sum + s.profiles.reduce((acc, p) => acc + Math.max(0, p.appBound || 0), 0),
    0,
  );
  return { sources: summary, importable, appBound };
}

function commandGuide() {
  return {
    note: '新版浏览器（Chrome/Edge 127+）用应用绑定加密保存密码，只能走官方导出。',
    steps: [
      'Chrome：打开 chrome://password-manager/settings → 「下载文件」，导出 CSV',
      'Edge：打开 edge://settings/passwords → 右上角「…」→「导出密码」',
      'Firefox：about:logins → 右上角「…」→「导出登录信息」',
      '导出时系统会要求 Windows Hello / 账户密码确认，这是浏览器自身的安全检查',
      '然后执行：keynest-cli import --csv <导出文件.csv>',
      '导入完成后建议删除 CSV（它是明文）',
    ],
    commands: {
      latest: 'node legacy/src/cli/keynest-cli.js import',
      explicit: 'node legacy/src/cli/keynest-cli.js import --csv "%USERPROFILE%\\Downloads\\Chrome 密码.csv"',
      overwrite: 'node legacy/src/cli/keynest-cli.js import --mode overwrite',
      dryRun: 'node legacy/src/cli/keynest-cli.js import --dry-run',
      ci: '$env:KEYNEST_PASSWORD="***"; node legacy/src/cli/keynest-cli.js import --password-env KEYNEST_PASSWORD',
    },
  };
}

/* ---------------------------- 输出与入口 ---------------------------- */

function printHuman(result) {
  const lines = [];
  if (result.file) {
    lines.push(`文件：${result.file}`);
    lines.push(`模式：${result.mode}${result.dryRun ? '（预演，未写入）' : ''}`);
    lines.push(`解析：${result.parsed} 条${result.skippedRows ? `，跳过空行 ${result.skippedRows}` : ''}`);
    lines.push(`新增：${result.added}    更新：${result.updated}    跳过：${result.skipped}    无效：${result.invalid}`);
    lines.push(`仓库条目：${result.totalBefore} → ${result.totalAfter}`);
  } else if (result.sources) {
    lines.push('本机浏览器密码库：');
    for (const source of result.sources) {
      for (const p of source.profiles) {
        const bound = p.appBound > 0 ? `，应用绑定加密 ${p.appBound}` : '';
        lines.push(`  ${source.name} / ${p.dir}：共 ${p.total}，可直接读 ${Math.max(0, p.importable)}${bound}`);
      }
    }
    if (!result.sources.length) lines.push('  （没有检测到 Chrome / Edge / Brave / Chromium）');
    lines.push(`合计：可直接读 ${result.importable} 条，需 CSV 导出 ${result.appBound} 条`);
  } else if (result.steps) {
    lines.push(result.note);
    for (const step of result.steps) lines.push(`  • ${step}`);
    lines.push('');
    lines.push('常用命令：');
    for (const [name, cmd] of Object.entries(result.commands)) lines.push(`  ${name}: ${cmd}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function usage() {
  process.stdout.write(
    [
      '钥巢 KeyNest CLI',
      '',
      '用法：',
      '  node legacy/src/cli/keynest-cli.js import [--csv FILE] [--dir DIR] [--mode skip|overwrite]',
      '                                      [--dry-run] [--data-dir DIR]',
      '                                      [--password-env NAME | --password-stdin]',
      '  node legacy/src/cli/keynest-cli.js scan',
      '  node legacy/src/cli/keynest-cli.js guide [--json]',
      '',
      '主密码不会从命令行参数读取，避免进入 shell 历史与进程列表。',
    ].join('\n') + '\n',
  );
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || 'help';
  const asJson = flagBool(args, 'json');

  let result;
  if (command === 'import') result = await commandImport(args);
  else if (command === 'scan') result = commandScan();
  else if (command === 'guide') result = commandGuide();
  else if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  } else {
    process.stderr.write(`未知命令：${command}\n`);
    usage();
    return 2;
  }

  if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printHuman(result);

  // 导入时如果一条都没写进去，用非零退出码方便脚本判断
  if (command === 'import' && !result.dryRun && result.added === 0 && result.updated === 0) return 3;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const code = err && err.code ? err.code : 'UNEXPECTED';
      process.stderr.write(`✗ ${err && err.message ? err.message : err}\n`);
      if (!(err instanceof VaultError) && process.env.KEYNEST_DEBUG) console.error(err);
      process.exitCode = 1;
      if (code === 'INVALID_PASSWORD') process.exitCode = 4;
    });
}

module.exports = {
  main,
  parseArgs,
  findLatestCsv,
  defaultCsvDirs,
  readCsvFile,
  commandImport,
  commandScan,
  commandGuide,
  resolveMasterPassword,
};
