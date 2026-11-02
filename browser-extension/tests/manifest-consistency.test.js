// manifest 与模块声明的一致性测试。
//
// # 这个文件存在的理由
//
// 「manifest 里加了个权限，但没有任何模块在用」是这类扩展最常见的腐化方式。
// 它不会报错、不会崩，只会让用户在安装时看到更长的一串权限提示，
// 然后怀疑这个扩展到底要干什么。
//
// 所以把 diffManifest 接进测试：任何一侧漏改，这里立刻红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHost } from '../lib/host.js';
import { diffManifest } from '../lib/permissions.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_BASE = `chrome-extension://${EXT_ID}/`;

/** 最小可用的假 chrome（含 dNR，让 adblock 模块也被注册）。 */
function fakeChrome() {
  return {
    runtime: {
      id: EXT_ID,
      getURL: () => EXT_BASE,
      connectNative: () => ({
        postMessage() {},
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
      }),
      onMessage: { addListener() {} },
    },
    tabs: { onRemoved: { addListener() {} }, sendMessage: async () => ({}) },
    webNavigation: { onCommitted: { addListener() {} }, getFrame: async () => ({}) },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    crypto: { getRandomValues: (a) => a },
  };
}

function readManifest() {
  const p = path.resolve(import.meta.dirname, '../manifest.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('PASS: manifest 与模块声明完全一致', async () => {
  const manifest = readManifest();
  const host = await createHost(fakeChrome());
  const d = diffManifest(manifest, host.registry.list());

  assert.deepEqual(d.missing, [], '模块需要但 manifest 没声明的权限');
  assert.deepEqual(d.unused, [], 'manifest 声明了但没有模块使用（权限膨胀）');
  assert.deepEqual(d.missingHosts, [], '缺少 host 权限');
  assert.deepEqual(d.unknownCapabilities, []);
  assert.equal(d.ok, true);
});

test('FAIL-SAFE: 权限清单能抓出「加了模块但忘加权限」', async () => {
  const manifest = readManifest();
  const host = await createHost(fakeChrome(), {
    extraModules: [
      {
        id: 'notify',
        title: '通知',
        requires: ['notifications'],
        handlers: [{ type: 'notify.ping', handle: () => ({ ok: true }) }],
      },
    ],
  });
  const d = diffManifest(manifest, host.registry.list());
  assert.deepEqual(d.missing, ['notifications']);
  assert.equal(d.ok, false);
});

test('FAIL-SAFE: 权限清单能抓出「加了权限但没模块用」', async () => {
  const manifest = readManifest();
  const host = await createHost(fakeChrome());
  const inflated = {
    ...manifest,
    permissions: [...manifest.permissions, 'tabs', 'bookmarks'],
  };
  const d = diffManifest(inflated, host.registry.list());
  assert.deepEqual(d.unused, ['bookmarks', 'tabs']);
  assert.equal(d.ok, false);
});

test('FAIL-SAFE: 权限清单不会把 optional_host_permissions 误报成缺失', async () => {
  // 本项目把全站 host 放在 optional 里（安装时不弹窗）。
  // 只看 host_permissions 会一直误报，那样的报警很快就没人看了。
  const manifest = readManifest();
  assert.deepEqual(manifest.host_permissions || [], [], '本项目的全站权限在 optional 里');
  assert.ok((manifest.optional_host_permissions || []).includes('https://*/*'));

  const host = await createHost(fakeChrome());
  const d = diffManifest(manifest, host.registry.list());
  assert.deepEqual(d.missingHosts, []);
});

/* ============================ manifest 自身约束 ============================ */

test('FAIL-SAFE: manifest 不声明高风险权限', async () => {
  const m = readManifest();
  // 这几项一旦出现，等于把这个扩展变成能读所有页面内容的工具。
  // 真需要时必须是一次显式决定 + 单独审查，不能顺手加。
  const FORBIDDEN = [
    'webRequest',
    'webRequestBlocking',
    'debugger',
    'proxy',
    'management',
    'declarativeWebRequest',
  ];
  for (const p of FORBIDDEN) {
    assert.equal(m.permissions.includes(p), false, `不该声明 ${p}`);
  }
});

test('FAIL-SAFE: content script 只在主 frame 注入', async () => {
  const m = readManifest();
  for (const cs of m.content_scripts || []) {
    assert.equal(
      cs.all_frames,
      false,
      'all_frames:true 会让跨站 iframe 也跑 content script，扩大攻击面'
    );
  }
});

test('PASS: content script 只匹配 https', async () => {
  const m = readManifest();
  for (const cs of m.content_scripts || []) {
    for (const pattern of cs.matches) {
      assert.ok(pattern.startsWith('https://'), `${pattern} 不是 https`);
    }
  }
});

test('FAIL-SAFE: 不声明 web_accessible_resources 暴露内部文件', async () => {
  const m = readManifest();
  assert.deepEqual(m.web_accessible_resources, [], '暴露内部文件等于让网页能加载它们');
});

test('PASS: storage 权限只为持久化配置而存在（阶段 3.0 的显式决定）', async () => {
  const m = readManifest();
  // 阶段 2.8 曾刻意不声明 storage；阶段 3.0 为了持久化用户设置而打开。
  // 只有声明 configStore 能力的模块才该用它；一旦有模块绕过配置中心存敏感数据，
  // scanForSensitiveKeys 会报出来。
  assert.equal(m.permissions.includes('storage'), true);
  const host = await createHost(fakeChrome());
  assert.deepEqual(host.registry.capabilityOwners('configStore'), ['registry']);
});

test('PASS: manifest version 与 package.json 一致', async () => {
  const m = readManifest();
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')
  );
  assert.equal(m.version, pkg.version, '两处版本号必须同步');
});

test('PASS: options_ui 指向的页面在实际特权白名单里', async () => {
  const m = readManifest();
  const { PRIVILEGED_PAGES } = await import('../lib/host.js');
  const page = m.options_ui.page.replace(/^\.?\//, '');
  assert.ok(
    PRIVILEGED_PAGES.includes(page),
    `options_ui 指向 ${page}，但它不在 PRIVILEGED_PAGES 里——设置页会发不出任何特权消息`
  );
});

test('PASS: service worker 文件真实存在', async () => {
  const m = readManifest();
  const sw = path.resolve(import.meta.dirname, '..', m.background.service_worker);
  assert.ok(fs.existsSync(sw), `${sw} 不存在`);
});
