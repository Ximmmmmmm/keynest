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

/**
 * 从 `release.yml` 里读出扩展文件的打包白名单。
 *
 * 抽成函数是因为现在有两处要用：双向比对、以及传递依赖检查。
 * 两处各写一份正则，将来改了白名单的写法就会只更新一处。
 *
 * @returns {string[]|null} 读不出来时返回 null（调用方各自报错）
 */
function whitelistFiles() {
  const yml = read('.github/workflows/release.yml');
  if (yml === null) return null;
  const m = yml.match(/\$files\s*=\s*@\(([\s\S]*?)\n\s*\)/);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
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
/* 4a2) 扩展的**传递**依赖必须都在白名单里                               */
/* ------------------------------------------------------------------ */

/**
 * 从 service-worker / content-script / popup / options 出发，
 * 沿着 `import ... from './x.js'` 走一遍，检查闭包里每个文件都在白名单里。
 *
 * # 为什么「文件存在」不够
 *
 * 前面那条检查只确认「白名单里的文件存在」。但真正决定扩展能不能跑的
 * 是**反过来**：运行时 import 的模块是不是都在包里。
 *
 * 漏一个的后果是扩展装上直接白屏，而打包阶段一切正常——
 * 因为那个文件确实存在于仓库里，只是没被复制进 zip。
 *
 * 这个项目已经吃过一次亏：白名单漏了 5 个 lib 文件，
 * 装上就白屏。当时是靠人工比对发现的。
 *
 * # 局限
 *
 * 只看静态 `from './...'`。动态 import、拼接路径、
 * 以及 `chrome.scripting.executeScript({files:[...]})` 里的字符串
 * 都不在覆盖范围。但本项目这几处都是静态写法，覆盖已经足够。
 */
{
  const extRoot = path.join(REPO, 'browser-extension');
  const wl = whitelistFiles();
  if (wl && fs.existsSync(extRoot)) {
    const seen = new Set();
    const outside = [];
    const unreadable = [];

    const visit = (rel) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      if (!wl.includes(rel)) outside.push(rel);

      const full = path.join(extRoot, rel);
      if (!fs.existsSync(full)) return;
      let src;
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch {
        unreadable.push(rel);
        return;
      }
      for (const m of src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
      }
    };

    for (const entry of [
      'background/service-worker.js',
      'content/content-script.js',
      'popup/popup.js',
      'options/options.js',
    ]) {
      visit(entry);
    }

    if (outside.length) {
      fail(
        '扩展运行时会 import 但不在白名单里的文件（装上会白屏）',
        [...new Set(outside)].join(', '),
      );
    } else if (unreadable.length) {
      fail('扩展文件读不出来', unreadable.join(', '));
    } else {
      ok('扩展的传递依赖都在白名单里', `${seen.size} 个`);
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
/* 4c) 本地 CI 复现脚本必须与 CI 配置保持一致                            */
/* ------------------------------------------------------------------ */

/**
 * 检查 `scripts/ci-local.sh` 里跑的命令与 `ci.yml` 里写的一致。
 *
 * # 为什么需要
 *
 * `scripts/ci-local.sh` 的意义是「本地能一键跑完 CI 的每一步」。
 * 但如果它和 CI 配置各写各的，这个脚本会慢慢变成**另一套**流程——
 * 本地全绿、CI 全红，而两边都说不清是哪里不一样。
 *
 * 这正是上一轮那个 bug 的同族：两份本该一致的东西悄悄分开了。
 *
 * # 怎么比
 *
 * 不做精确解析（YAML 与 shell 都太灵活），而是取 CI 里每条 run 的
 * **命令行**，看它有没有出现在本地脚本文本里。
 *
 * 方向的取舍：只检查「CI 有的、本地没有的」——
 * 本地多跑一步（比如多跑一次 release 构建）是无害的，
 * 而 CI 有、本地没有，才是真正的漏洞。
 */
{
  const ci = read('.github/workflows/ci.yml');
  const local = read('scripts/ci-local.sh');
  if (ci !== null && local !== null) {
    // 提取 CI 里所有 run 的命令行
    const ciCmds = [];
    const lines = ci.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*run:\s*(.+)$/);
      if (!m) continue;
      const inline = m[1].trim();
      if (inline.startsWith('|')) {
        // 多行块：收集直到缩进回退
        const baseIndent = lines[i].match(/^\s*/)[0].length;
        let j = i + 1;
        for (; j < lines.length; j += 1) {
          const l = lines[j];
          if (l.trim() === '') continue;
          const ind = l.length - l.trimStart().length;
          if (ind <= baseIndent) break;
          const t = l.trim();
          if (t.startsWith('#')) continue;
          ciCmds.push(t);
        }
        i = j - 1;
      } else {
        ciCmds.push(inline);
      }
    }

    // 只看「会执行什么」：第一词是**有意义的动词**的命令。
    //
    // 辅助行（`count=$(...)`、`echo ...`、`if ...`）不算——
    // 本地脚本的辅助写法与 CI 不一定一样，比它们只会产生误报。
    const VERBS = ['cargo', 'node', 'npm', 'bash', 'dotnet', 'python', 'pip'];
    const interesting = ciCmds.filter((c) => {
      const t = c.trim();
      if (!t) return false;
      const verb = t.split(/\s+/)[0];
      return VERBS.includes(verb);
    });

    const missing = [];
    for (const c of interesting) {
      // CI 里 `node "$f"` 与本地的 `node "$f"` 一致；
      // 但 CI 用的是变量名 `$f`/`$files`，本地可能不同，所以宽松一点：
      // 取命令的**第一个词 + 关键参数**做匹配。
      const norm = c.replace(/\s+/g, ' ').trim();
      if (local.includes(norm)) continue;
      // 再试一次：忽略末尾的参数（多行块里常有 cd 之类的前缀）
      const head = norm.split(' ').slice(0, 2).join(' ');
      if (head.length > 6 && local.includes(head)) continue;
      missing.push(norm);
    }

    if (missing.length === 0) {
      ok('本地 CI 脚本覆盖了 CI 的每条命令', `${interesting.length} 条`);
    } else {
      fail(
        '本地 CI 脚本没覆盖 CI 的某些命令（两边会漂移）',
        missing.slice(0, 3).join(' | '),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4d) 发布流程的三份文件清单必须互相覆盖                              */
/* ------------------------------------------------------------------ */

/**
 * `release.yml` 里有**三处**会列出「发布时有哪些文件」：
 *
 * 1. `sha256sum ...` —— 给它算哈希的文件
 * 2. 敏感文件检查的 `grep -vE '^(...)$'` 白名单
 * 3. `创建 Release` 那一步的 `files: |` 附件列表
 *
 * 三者**必须覆盖同一批文件**，任一处漏了都会出问题：
 *
 * - 1 有、2 没有 → 敏感检查把刚算过哈希的文件判成「预期之外」，**发布 exit 1**
 * - 1 有、3 没有 → SHA256SUMS 里有哈希但附件里没文件，用户校验对不上，
 *   而且那个产物根本下载不到（浏览器桥接就装不了）
 *
 * 这两个缺口都真的存在过，而且都是**静默的**：
 * `fail_on_unmatched_files` 只管「列出来的文件在不在」，漏列不报错。
 */
{
  const yml = read('.github/workflows/release.yml');
  if (yml !== null) {
    // ---- 1) sha256sum 列的文件 ----
    const hashed = listAfter(yml, 'sha256sum ', 'SHA256SUMS');

    // ---- 2) 敏感文件检查白名单 ----
    const gIdx = yml.indexOf("grep -vE '^(");
    let allowed = [];
    if (gIdx !== -1) {
      const tail = yml.slice(gIdx + "grep -vE '^(".length);
      const close = tail.indexOf(')$' + "'");
      if (close !== -1) {
        allowed = tail
          .slice(0, close)
          .split('|')
          .map((x) => x.replace(/\\/g, ''))
          .filter(Boolean);
      }
    }

    // ---- 3) Release 附件列表 ----
    const fIdx = yml.indexOf('files: |');
    let assets = [];
    if (fIdx !== -1) {
      const rest = yml.slice(fIdx + 'files: |'.length);
      for (const raw of rest.split('\n')) {
        const t = raw.trim();
        if (t === '') { if (assets.length) break; else continue; }
        if (!t.startsWith('release-stage/')) break;
        assets.push(t.slice('release-stage/'.length));
      }
    }

    // glob 用前缀比
    const covered = (name, list) => {
      if (name.includes('*')) {
        const prefix = name.split('*')[0];
        return list.some((x) => x.startsWith(prefix));
      }
      return list.includes(name);
    };

    if (!hashed.length || !allowed.length || !assets.length) {
      fail('release.yml 里有一处文件清单读不出来（发布流程结构变了？）');
    } else {
      // 1 有、2 没有
      const notAllowed = hashed.filter((h) => !covered(h, allowed));
      if (notAllowed.length) {
        fail(
          '敏感文件白名单漏了算过哈希的文件（发布必 exit 1）',
          notAllowed.join(', '),
        );
      }
      // 1 有、3 没有
      const notShipped = hashed.filter((h) => !covered(h, assets));
      if (notShipped.length) {
        fail(
          'Release 附件漏了算过哈希的文件（用户下载不到，校验也对不上）',
          notShipped.join(', '),
        );
      }
      if (!notAllowed.length && !notShipped.length) {
        ok('发布流程的三份文件清单互相覆盖', `${hashed.length} 个`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */

/**
 * 取 `marker` 之后、到 `stop` 之前，按空白切出来的 token 列表。
 *
 * 刻意用字符串切分而不是正则——这个文件被转义问题坑过多次。
 *
 * @param {string} text
 * @param {string} marker
 * @param {string} stop
 * @returns {string[]}
 */
function listAfter(text, marker, stop) {
  const i = text.indexOf(marker);
  if (i === -1) return [];

  const out = [];
  // 逐行、逐 token 收集；反斜杠续行就继续下一行
  for (const raw of text.slice(i + marker.length).split('\n')) {
    const t = raw.trim();
    const body = t.endsWith('\\') ? t.slice(0, -1) : t;
    for (const tok of body.split(' ')) {
      const v = tok.trim();
      if (!v) continue;
      if (v.includes(stop)) return out;
      if (/^[></|&]+$/.test(v)) continue;
      out.push(v);
    }
    if (!t.endsWith('\\')) break;
  }
  return out;
}
/* ------------------------------------------------------------------ */
/* 4e) workflow 里的 action 必须 pin 到完整 SHA                          */
/* ------------------------------------------------------------------ */

/**
 * 检查 `.github/workflows/*.yml` 里每个 `uses:` 都是 40 位 commit SHA。
 *
 * # 为什么
 *
 * 用 tag 或分支引用 action（`actions/checkout@v4`）意味着上游可以
 * 随时把那个 tag 指向任意 commit——包括被入侵的账号推的恶意 commit。
 * 而 workflow 里的 action 跑在 CI 里，**能读到仓库内容、拿到
 * GITHUB_TOKEN**。这是真实发生过的攻击面（tj-actions 事件）。
 *
 * pin 到完整 SHA 之后，上游改不了我们跑的是什么。
 *
 * # 局限
 *
 * 这条只保证「格式是 40 位 SHA」，不验证那个 SHA 在 GitHub 上
 * 是否真的存在、是否指向预期的版本——那需要网络请求，
 * 不适合放进一个离线自检。本轮已经用 GitHub API 逐个核实过
 * 当前这 9 个 action 的 SHA 全部存在。
 */
{
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = read(file);
    if (text === null) continue;

    const unpinned = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)@(\S+)\s*$/);
      if (!m) continue;
      const [, action, ref] = m;
      if (!/^[a-f0-9]{40}$/.test(ref)) {
        unpinned.push(`${action}@${ref}`);
      }
    }

    if (unpinned.length) {
      fail(
        `${file} 里有 action 没 pin 到完整 SHA（上游可替换）`,
        unpinned.slice(0, 3).join(', '),
      );
    } else {
      ok(`${file} 的 action 全部 pin 到 SHA`, '');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4f) 桥接协议：扩展用的命令必须在 Rust 侧有定义                        */
/* ------------------------------------------------------------------ */

/**
 * 扩展通过 Native Messaging 向 `keynest-native-host.exe` 发命令，
 * 再由它转成桥接协议发给 GUI 侧的 Rust 进程。
 *
 * 命令名是**字符串**，编译器不检查两边是否一致——
 * 扩展写了 `vault.fil`，Rust 侧只有 `vault.fill`，
 * 结果是运行时返回 UNKNOWN_COMMAND，用户只看到「填充失败」。
 *
 * # 只查一个方向
 *
 * **扩展用了但 Rust 没定义** = 真 bug（请求必然被拒）。
 * 反过来「Rust 定义了但扩展没用」不是问题——
 * `hello` 是握手用的，`vault.save` / `vault.conflict` 是刻意留的、
 * 且 GUI 侧明确返回「尚未启用」的预留命令。
 */
{
  const rs = read('rust/keynest-bridge/src/protocol.rs');
  const js = read('browser-extension/lib/modules/vault.js');
  if (rs !== null && js !== null) {
    // Rust 侧：Command::X => "name"
    const defined = [...rs.matchAll(/Command::\w+ => "([a-z.]+)"/g)].map((m) => m[1]);
    // 扩展侧：deps.request('name', ...)
    const used = [...new Set([...js.matchAll(/request\('([a-z.]+)'/g)].map((m) => m[1]))];

    const unknown = used.filter((u) => !defined.includes(u));
    if (unknown.length) {
      fail('扩展用了 Rust 侧没定义的桥接命令（运行时会被拒）', unknown.join(', '));
    } else {
      ok('扩展用到的桥接命令 Rust 侧都有定义', `${used.length} 个`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4g) 原生宿主名与协议版本：两端必须一致                              */
/* ------------------------------------------------------------------ */

/**
 * 扩展通过 `chrome.runtime.connectNative(HOST_NAME)` 连接原生宿主，
 * 浏览器**只认注册表里的那个名字**。Rust 侧写注册表时用的是自己的常量。
 *
 * 两边不一致的后果：扩展「已安装」、注册表项也写好了，
 * 但 `connectNative` 立刻返回已断开的端口，
 * 用户看到的是「浏览器桥接没有就绪」，完全指不到真正的原因。
 *
 * `PROTOCOL_VERSION` 同理：版本对不上，握手直接失败。
 *
 * # 局限
 *
 * 这里只比对**字面量**。两边都用常量这件事本身就是好事——
 * 真正要防的是「有人改了一边忘了另一边」。
 */
{
  const rs =
    read('rust/keynest-bridge/src/hostinstall.rs') +
    (read('rust/keynest-bridge/src/limits.rs') || '');
  const js = read('browser-extension/lib/modules/vault.js');
  if (rs !== null && js !== null) {
    const pairs = [
      ['HOST_NAME', /HOST_NAME: &str = "([^"]+)"/, /HOST_NAME = '([^']+)'/],
      ['PROTOCOL_VERSION', /PROTOCOL_VERSION: u32 = (\d+)/, /PROTOCOL_VERSION = (\d+)/],
    ];

    const mismatched = [];
    for (const [name, rre, jre] of pairs) {
      const rm = rs.match(rre);
      const jm = js.match(jre);
      if (!rm || !jm) {
        mismatched.push(`${name}（有一侧读不到）`);
      } else if (rm[1] !== jm[1]) {
        mismatched.push(`${name}: Rust=${rm[1]} 扩展=${jm[1]}`);
      }
    }

    if (mismatched.length) {
      fail('原生宿主名/协议版本两端不一致（桥接会连不上）', mismatched.join('; '));
    } else {
      ok('原生宿主名与协议版本两端一致', '');
    }
  }
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
