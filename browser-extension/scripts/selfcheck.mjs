// 离线自检：不启动浏览器，验证扩展的装配是否自洽。
//
// # 为什么需要这个
//
// 真实 Chrome 验收要启动浏览器、注册 Host、注入键鼠——代价高，
// 而且会占用用户机器。但"装配错了"这类问题（模块没注册、权限对不上、
// 消息类型漏声明）**不需要真实浏览器就能查出来**。
//
// 这个脚本用假 chrome.* 把宿主建起来，然后逐项检查：
//
//   1. 所有模块都注册成功（含 adblock / reader / dark 这些条件模块）
//   2. manifest 与模块声明的权限完全一致
//   3. 每条消息类型都在门禁表里（漏声明的会默认 `any`，那是攻击面）
//   4. 每个 handler 的 type 都能被分派到
//   5. 内容脚本没有 import（MV3 硬约束）
//   6. content script 引用的消息类型在门禁表里存在
//
// 它**不能**替代真实浏览器验收：真实环境才能发现 Chrome 的字段名、
// 权限时序、DOM 行为差异。但它能在不打扰用户的前提下抓住装配层的问题。
//
// ```bash
// node scripts/selfcheck.mjs
// ```

import fs from 'node:fs';
import path from 'node:path';

import { createHost, KIND_REQUIREMENT, PRIVILEGED_PAGES } from '../lib/host.js';
import { diffManifest, CAPABILITIES } from '../lib/permissions.js';
import { autoApplyModules } from '../lib/auto-apply.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_BASE = `chrome-extension://${EXT_ID}/`;

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail: detail ?? null });
  process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** 一个"什么都支持"的假 chrome：让条件模块（adblock/reader/dark）都能注册。 */
function fullFakeChrome() {
  const listeners = { message: [], removed: [], committed: [] };
  return {
    runtime: {
      id: EXT_ID,
      getURL: () => EXT_BASE,
      connectNative: () => ({
        postMessage() {},
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    tabs: {
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
      sendMessage: async () => ({ ok: true }),
    },
    webNavigation: {
      onCommitted: { addListener: (fn) => listeners.committed.push(fn) },
      getFrame: async () => ({ url: 'https://a.test/', documentId: 'd1' }),
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
    },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    permissions: { contains: async () => true, request: async () => true },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {},
        async remove() {},
      },
    },
    crypto: { getRandomValues: (a) => a },
  };
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
}

async function main() {
  process.stdout.write('=== 扩展装配自检（离线，不启动浏览器）===\n\n');

  const manifest = readJson('manifest.json');
  const host = await createHost(fullFakeChrome());
  const registry = host.registry;

  /* ---------------- 1. 模块注册 ---------------- */

  const ids = registry.list().map((m) => m.id);
  check('核心模块已注册', ids.includes('vault') && ids.includes('registry'), ids.join(','));

  const cond = [];
  if (!ids.includes('adblock')) cond.push('adblock');
  if (!ids.includes('reader')) cond.push('reader');
  if (!ids.includes('dark')) cond.push('dark');
  check('能力相关模块都已注册（假 chrome 提供了全部 API）', cond.length === 0, cond.join(','));

  /* ---------------- 2. 权限一致 ---------------- */

  const diff = diffManifest(manifest, registry.list());
  check(
    'manifest 与模块声明的权限一致',
    diff.ok,
    diff.ok ? '' : JSON.stringify(diff)
  );

  /* ---------------- 3. 消息类型都在门禁表 ---------------- */

  const declared = Object.keys(KIND_REQUIREMENT);
  const unlisted = [];
  for (const entry of registry.entries()) {
    for (const h of entry.raw.handlers || []) {
      if (!declared.includes(h.type)) unlisted.push(h.type);
    }
  }
  // 允许显式声明为 any 的类型；未声明会落到默认 any，那是攻击面，所以要求逐条列出
  check(
    '每个 handler 的消息类型都显式声明了来源',
    unlisted.length === 0,
    unlisted.length ? `未声明: ${unlisted.join(',')}` : ''
  );

  /* ---------------- 4. 门禁表里没有孤立项 ---------------- */

  const registered = new Set();
  for (const entry of registry.entries()) {
    for (const h of entry.raw.handlers || []) registered.add(h.type);
  }
  // auto.apply 不是模块 handler，是宿主自己处理的，单独放行
  const HOST_HANDLED = new Set(['auto.apply']);
  const orphans = declared.filter((t) => !registered.has(t) && !HOST_HANDLED.has(t));
  check(
    '门禁表里没有指向不存在 handler 的条目',
    orphans.length === 0,
    orphans.length ? orphans.join(',') : ''
  );

  /* ---------------- 5. 门禁值合法 ---------------- */

  const badKinds = Object.entries(KIND_REQUIREMENT).filter(
    ([, v]) => !['popup', 'content', 'any'].includes(v)
  );
  check(
    '门禁值只允许 popup / content / any',
    badKinds.length === 0,
    badKinds.map(([k, v]) => `${k}=${v}`).join(',')
  );

  /* ---------------- 5b. 门禁表没有重复键 ---------------- */

  // 对象字面量里的重复键会**静默覆盖**前一个值——没有任何报错。
  // 表现是"某条消息的门禁莫名其妙变了"，排查起来极其费劲。
  // 所以直接扫源码，不依赖运行时（运行时已经看不到被覆盖的那个了）。
  {
    const hostSrc = fs.readFileSync(path.join(ROOT, 'lib/host.js'), 'utf8');
    const block = hostSrc.slice(hostSrc.indexOf('export const KIND_REQUIREMENT'));
    const keys = [...block.matchAll(/^\s*'([a-z][a-z0-9.-]*)':/gm)].map((m) => m[1]);
    const dups = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    check('门禁表没有重复键（重复会静默覆盖）', dups.length === 0, dups.join(','));
  }

  /* ---------------- 6. 能力名都在清单里 ---------------- */

  const unknownCaps = [];
  for (const entry of registry.entries()) {
    for (const c of entry.requires) {
      if (!(c in CAPABILITIES)) unknownCaps.push(`${entry.id}:${c}`);
    }
  }
  check('模块声明的能力都在 CAPABILITIES 里', unknownCaps.length === 0, unknownCaps.join(','));

  /* ---------------- 7. 内容脚本无 import ---------------- */

  const csPath = path.join(ROOT, manifest.content_scripts?.[0]?.js?.[0] || '');
  if (fs.existsSync(csPath)) {
    const src = fs.readFileSync(csPath, 'utf8');
    const hasImport = /^\s*import\s/m.test(src);
    check('内容脚本没有 import（MV3 硬约束）', !hasImport);
  } else {
    check('内容脚本文件存在', false, csPath);
  }

  /* ---------------- 8. 内容脚本引用的消息类型存在 ---------------- */

  if (fs.existsSync(csPath)) {
    const src = fs.readFileSync(csPath, 'utf8');
    const used = [...src.matchAll(/type:\s*'([a-z][a-z0-9.-]*)'/g)].map((m) => m[1]);
    const unknown = [...new Set(used)].filter((t) => !declared.includes(t));
    // prepare-fill / redeem-now 是 SW 发给内容脚本的，不在宿主门禁表里
    const FROM_SW = new Set(['prepare-fill', 'redeem-now']);
    const missing = unknown.filter((t) => !FROM_SW.has(t));
    check(
      '内容脚本发出的消息类型都在门禁表里',
      missing.length === 0,
      missing.join(',')
    );
  }

  /* ---------------- 9. 特权页面白名单与 options_ui 一致 ---------------- */

  const optPage = (manifest.options_ui?.page || '').replace(/^\.?\//, '');
  check(
    'options_ui 页面在特权白名单里',
    PRIVILEGED_PAGES.includes(optPage),
    `${optPage} vs ${PRIVILEGED_PAGES.join('|')}`
  );

  /* ---------------- 10. 自动应用模块 ---------------- */

  const auto = autoApplyModules(registry);
  check(
    '至少有一个模块支持自动应用',
    auto.length > 0,
    auto.join(',')
  );

  /* ---------------- 11. 没有声明高风险权限 ---------------- */

  const FORBIDDEN = ['webRequest', 'webRequestBlocking', 'debugger', 'proxy', 'management'];
  const bad = FORBIDDEN.filter((p) => (manifest.permissions || []).includes(p));
  check('没有声明高风险权限', bad.length === 0, bad.join(','));

  /* ---------------- 12. 版本号同步 ---------------- */

  const pkg = readJson('package.json');
  check('manifest 与 package.json 版本一致', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);

  /* ---------------- 汇总 ---------------- */

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write(`\n=== 结果：${checks.length - failed.length}/${checks.length} 通过 ===\n`);
  if (failed.length) {
    process.stdout.write(`失败项：\n${failed.map((f) => `  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

await main();
