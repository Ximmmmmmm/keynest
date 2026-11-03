#!/usr/bin/env node
// 发布前自检。
//
// # 为什么需要它
//
// 本项目有三套独立的版本号（桌面程序 0.4.x、扩展 0.13.x、库 0.1.x），
// 加上发布流程里的扩展文件白名单——这几处的**手工同步**出过错：
//
// - 扩展的版本检查一度写成「必须等于 tag 版本」，而两套版本号从来就不相等
//   → **每次发布都失败**
// - 白名单里写了三个扩展根本不存在的图标文件 → **打包直接失败**
// - 白名单漏了 5 个运行时必需的 lib 文件 → **扩展装上就白屏**
//
// 这些问题都**不会**被编译器和测试发现，只在真正发布时才暴露。
// 所以把它们做成一个可以随时跑的检查。
//
// ```bash
// node scripts/release-check.mjs
// ```
//
// 退出码 0 = 全部通过；1 = 有问题（逐条列出）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

function fail(what, detail) {
  problems.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

function ok(what, detail) {
  notes.push(`${what}${detail ? ` — ${detail}` : ''}`);
}

function read(rel) {
  const p = path.join(REPO, rel);
  if (!fs.existsSync(p)) {
    fail(`缺少文件 ${rel}`);
    return null;
  }
  return fs.readFileSync(p, 'utf8');
}

/* ------------------------------------------------------------------ */
/* 1) 版本一致性                                                        */
/* ------------------------------------------------------------------ */

/**
 * 读 Cargo.toml 里的 version 字段。
 *
 * 只取第一个 `version = "..."`——Cargo.toml 顶部是包自身的版本，
 * 后面还可能有 `version = "1.0"` 这样的依赖版本要求。
 */
function cargoVersion(rel) {
  const text = read(rel);
  if (text === null) return null;
  const m = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) {
    fail(`${rel} 里找不到 version 字段`);
    return null;
  }
  return m[1];
}

function jsonField(rel, field) {
  const text = read(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text)[field];
  } catch (e) {
    fail(`${rel} 不是合法 JSON — ${e.message}`);
    return null;
  }
}

// 桌面程序与其 GUI 是同一个产品，版本必须一致
const coreVer = cargoVersion('rust/keynest-core/Cargo.toml');
const guiVer = cargoVersion('rust/keynest-egui/Cargo.toml');
if (coreVer && guiVer) {
  if (coreVer !== guiVer) {
    fail('桌面程序版本不一致', `core=${coreVer} egui=${guiVer}`);
  } else {
    ok('桌面程序版本一致', coreVer);
  }
}

// 库 crate 共享同一套版本号
const bridgeVer = cargoVersion('rust/keynest-bridge/Cargo.toml');
const pathsVer = cargoVersion('rust/keynest-paths/Cargo.toml');
if (bridgeVer && pathsVer) {
  if (bridgeVer !== pathsVer) {
    fail('库 crate 版本不一致', `bridge=${bridgeVer} paths=${pathsVer}`);
  } else {
    ok('库 crate 版本一致', bridgeVer);
  }
}

// 扩展有**自己独立**的版本号（0.13.x），与桌面程序不是一套
const mfVer = jsonField('browser-extension/manifest.json', 'version');
const pkgVer = jsonField('browser-extension/package.json', 'version');
if (mfVer && pkgVer) {
  if (mfVer !== pkgVer) {
    fail('扩展版本不一致', `manifest=${mfVer} package.json=${pkgVer}`);
  } else {
    ok('扩展版本一致', mfVer);
  }
} else if (mfVer && !pkgVer) {
  fail('扩展版本不一致', 'package.json 读不到版本');
}

/* ------------------------------------------------------------------ */
/* 2) CHANGELOG                                                         */
/* ------------------------------------------------------------------ */

{
  const text = read('CHANGELOG.md');
  if (text !== null && coreVer) {
    // 已有该版本的条目即可（正在开发中的版本可以还没写条目）
    const has = new RegExp(`^## \\[${coreVer.replace(/\./g, '\\.')}\\]`, 'm').test(text);
    const unreleased = /^## \[未发布\]/m.test(text);
    if (!has && !unreleased) {
      fail('CHANGELOG 里既没有该版本的条目，也没有「未发布」段');
    } else {
      ok('CHANGELOG 有对应条目', has ? coreVer : '未发布');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3) 必需文件                                                          */
/* ------------------------------------------------------------------ */

for (const f of [
  'README.md',
  'README_EN.md',
  'SECURITY.md',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'CHANGELOG.md',
  'CONTINUATION.md',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  // 本地一键复现 CI 的脚本：改了 CI 顺手跑一遍，改坏了当场就知道。
  'scripts/ci-local.sh',
]) {
  if (fs.existsSync(path.join(REPO, f))) {
    ok('必需文件存在', f);
  } else {
    fail('缺少必需文件', f);
  }
}

/* ------------------------------------------------------------------ */
/* 4) 发布流程里的扩展白名单                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 release.yml 里抠出扩展文件白名单。
 *
 * 白名单写成显式列表是刻意的（避免把测试文件、私钥、开发者本地的
 * vault.dat 打进发布包），但手工维护容易漏——
 * 漏一个运行时必需的文件，扩展装上就白屏。
 *
 * 所以这里做**双向**比对：
 *   - 白名单里的文件必须真的存在（否则打包时 Copy-Item 直接失败）
 *   - 扩展目录里的运行时文件必须都在白名单里（否则漏打包）
 */
{
  const yml = read('.github/workflows/release.yml');
  if (yml !== null) {
    const m = yml.match(/\$files\s*=\s*@\(([\s\S]*?)\n\s*\)/);
    if (!m) {
      fail('release.yml 里找不到扩展文件白名单');
    } else {
      const listed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

      // (a) 白名单里的文件必须存在
      const missing = listed.filter(
        (f) => !fs.existsSync(path.join(REPO, 'browser-extension', f)),
      );
      if (missing.length) {
        fail('白名单里的文件不存在（打包会失败）', missing.join(', '));
      } else {
        ok('白名单里的文件都存在', `${listed.length} 个`);
      }

      // (b) 扩展目录里的运行时文件必须在白名单里
      const extRoot = path.join(REPO, 'browser-extension');
      const actual = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', 'tests', 'scripts', '.git'].includes(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else {
            const rel = path.relative(extRoot, full).split(path.sep).join('/');
            if (!rel.endsWith('.md')) actual.push(rel);
          }
        }
      })(extRoot);

      const unlisted = actual.filter((f) => !listed.includes(f));
      if (unlisted.length) {
        fail('扩展里有文件没进白名单（会漏打包）', unlisted.join(', '));
      } else {
        ok('扩展的运行时文件都在白名单里', `${actual.length} 个`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4b) workflow 文件的块标量缩进                                        */
/* ------------------------------------------------------------------ */

/**
 * 检查 `run: |` 这类块标量的内容行缩进。
 *
 * # 为什么需要这个检查
 *
 * YAML 的块标量（`run: |`）里，内容的缩进决定它到哪儿为止。
 * 只要有一行的缩进**不大于** `run: |` 那一行，块就提前结束了——
 * 后面的内容被当成新的 YAML 节点，报一个
 * 「could not find expected ':'」的错误，而**真正的原因完全看不出来**。
 *
 * 实际的经过：CI 的扩展测试作业里有一行
 * `count=$(printf '%s
' "$files" | wc -l)`，编辑时转义被吃掉、
 * 换行变成了真的换行，于是引号落到行首、缩进为 0、块提前结束——
 * **整个 ci.yml 从此不是合法 YAML**，GitHub 连解析都过不去。
 * 而这种错误编译器和测试都发现不了。
 *
 * # 为什么不用「引号配平」
 *
 * 试过，但 PowerShell 的 here-string（`@"` … `"@`）与 awk 的单引号脚本
 * 本来就跨行，单行配平检查对它们全是误报。
 *
 * 缩进检查没有这个问题：跨行字符串的**内容行**缩进仍然是块内缩进，
 * 只有真正提前结束的行才会缩进变小。
 */
for (const rel of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = read(rel);
  if (text === null) continue;
  const lines = text.split('\n');

  let blockIndent = null; // 当前块标量的起始缩进
  let blockLine = 0;
  let problems = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (blockIndent !== null) {
      // 空行与注释行不算内容
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= blockIndent) {
        // 块结束了。正常情况下，结束它的是**下一个 YAML 节点**
        // （同级步骤 `- name: ...` 或一个键 `key: value`）。
        //
        // 如果结束它的是一行「不像 YAML 的东西」（比如某个引号没闭合
        // 导致的残片 `'" "$files" | wc -l)`），那说明块被**提前截断**了——
        // YAML 解析器会把后面当成新节点，报一个完全指不到原因的错。
        const looksLikeNode =
          /^\s*-\s/.test(line) || /^\s*[^\s#][^:]*:(\s|$)/.test(line);
        if (!looksLikeNode) {
          problems += 1;
          if (problems <= 3) {
            fail(
              `${rel} 第 ${i + 1} 行提前结束了第 ${blockLine} 行的块标量（YAML 会解析失败）`,
              trimmed.slice(0, 60),
            );
          }
        }
        blockIndent = null;
        // 继续按普通行处理这一行（它可能自己又是一个块标量）
      } else {
        continue; // 正常的内容行
      }
    }

    // 新的块标量：`run: |` / `run: |-` / `run: >` 之类
    const m = line.match(/^(\s*)(?:run|args):\s*[|>][-+]?\s*$/);
    if (m) {
      blockIndent = m[1].length;
      blockLine = i + 1;
    }
  }

  if (problems === 0) ok('workflow 块标量缩进正确', rel);
  else if (problems > 3) fail(`${rel} 还有 ${problems - 3} 处块标量提前结束`);
}

/* ------------------------------------------------------------------ */
/* 5) 仓库里不能有敏感或调试文件                                        */
/* ------------------------------------------------------------------ */

{
  const tracked = runGit(['ls-files']);
  if (tracked) {
    const files = tracked.split('\n').filter(Boolean);
    const bad = files.filter((f) =>
      /(^|\/)(vault\.dat|bridge\.key|.*\.key|\.env)$/i.test(f),
    );
    if (bad.length) {
      fail('仓库里有敏感文件', bad.join(', '));
    } else {
      ok('仓库里没有敏感文件');
    }

    // 体积异常大的文件（可能是误提交的构建产物或数据文件）
    const big = [];
    for (const f of files) {
      const full = path.join(REPO, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.size > 8 * 1024 * 1024) {
          big.push(`${f} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
        }
      } catch {
        /* 文件已被删除，忽略 */
      }
    }
    if (big.length) {
      fail('仓库里有超过 8 MB 的文件（可能是误提交的产物）', big.join(', '));
    } else {
      ok('仓库里没有异常大的文件');
    }
  }
}

function runGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

console.log('=== 发布前自检 ===\n');
for (const n of notes) console.log(`  ✓ ${n}`);
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n=== 结果：${problems.length} 个问题 ===`);
  process.exit(1);
}
console.log(`\n=== 结果：全部通过（${notes.length} 项检查）===`);
