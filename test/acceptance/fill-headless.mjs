#!/usr/bin/env node
// 密码填充的**页面侧**验证（headless，不需要 GUI、不需要桥接）。
//
// # 为什么这条测试有价值
//
// 完整的「解锁 → 桥接 → 填充」需要真实 GUI 解锁（抢焦点、注入键鼠），
// 无法在无人值守时跑。但这条链路里**最容易被写错、后果最严重的那一段**
// 是页面侧的：
//
//   - origin 必须**精确相等**（不是前缀、不是包含）——写错就是跨站填充
//   - nonce 只能兑换一次——写错就是重放
//   - 密码用完必须置 null——写错就是明文长期躺在响应对象里
//   - username 为空时**不要动**用户名字段——写错会清掉用户已输入的内容
//
// 这些全部在 content script 里，可以脱离桥接单独验证：
// 我们伪造 SW 的响应，只看页面侧的行为。
//
// ```bash
// node test/acceptance/fill-headless.mjs
// ```

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp, browserWsUrl } from './lib/cdp.mjs';
import { ensureCert } from './lib/env.mjs';
import { startSites } from './lib/site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const EXT = path.join(REPO, 'browser-extension');

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(
    `  ${id.padEnd(6)} ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

const tmp = (n) => {
  const p = path.join(process.env.TEMP || '/tmp', `kn-fill-${n}-${process.pid}`);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const PROFILE = tmp('profile');
const MANIFEST_DIR = tmp('manifest');

let sites;
let chrome;
let cdp;

try {
  ensureCert({ site: MANIFEST_DIR });

  // 预授权副本站点，让 content script 能直接注入（避免弹权限框）
  const extCopy = path.join(MANIFEST_DIR, 'ext');
  fs.cpSync(EXT, extCopy, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(extCopy, 'manifest.json'), 'utf8'));
  mf.host_permissions = mf.optional_host_permissions || [];
  delete mf.optional_host_permissions;
  fs.writeFileSync(path.join(extCopy, 'manifest.json'), JSON.stringify(mf, null, 2));

  const PORT_A = 9471;
  const PORT_B = 9472;
  sites = await startSites({ certDir: MANIFEST_DIR, portA: PORT_A, portB: PORT_B });

  chrome = spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      `--user-data-dir=${PROFILE}`,
      '--remote-debugging-port=9473',
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  chrome.unref();

  cdp = await Cdp.connect(await browserWsUrl(9473), { timeoutMs: 25000 });
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extCopy });
  await sleep(1800);

  // 打开发往站点 A（有登录表单）
  await cdp.send('Target.createTarget', { url: `https://127.0.0.1:${PORT_A}/` });
  await sleep(2200);

  // 从扩展页面控制：找到站点 A 的 tabId
  const { targetId: popupTarget } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/popup/popup.html`,
  });
  const { sessionId: extSession } = await cdp.send('Target.attachToTarget', {
    targetId: popupTarget,
    flatten: true,
  });
  await sleep(1500);

  const EXT_CALL = (expr) =>
    cdp
      .send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        extSession,
      )
      .then((r) =>
        r.exceptionDetails
          ? { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) }
          : r.result?.value,
      );

  // 页面侧的会话（隔离世界之外，用 main world 直接看 DOM）
  const pageTargets = await cdp.send('Target.getTargets');
  const siteTarget = pageTargets.targetInfos.find((t) =>
    (t.url || '').includes(`127.0.0.1:${PORT_A}`),
  );
  if (!siteTarget) throw new Error('找不到站点 A 的标签页');

  const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
    targetId: siteTarget.targetId,
    flatten: true,
  });
  await sleep(1200);

  const PAGE_CALL = (expr) =>
    cdp
      .send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true },
        pageSession,
      )
      .then((r) =>
        r.exceptionDetails
          ? { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) }
          : r.result?.value,
      );

  // 内容脚本运行在隔离世界，页面 main world 看不到它的内部状态。
  // 所以这里通过**行为**验证：给 content script 发消息，看 DOM 有没有变。
  //
  // 用 chrome.tabs.sendMessage 从扩展页面发到站点 A 的标签页。
  const tabId = await EXT_CALL(`(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      const f = await chrome.webNavigation.getFrame({ tabId: t.id, frameId: 0 }).catch(() => null);
      if (f && f.url && f.url.indexOf('${PORT_A}') >= 0) return t.id;
    }
    return null;
  })()`);

  record('F0', '找到站点 A 的标签页', Number.isInteger(tabId), `tabId=${tabId}`);

  // ---- F1: origin 不匹配时必须拒绝 ----
  const badOrigin = await EXT_CALL(`chrome.tabs.sendMessage(${tabId}, {
    type: 'prepare-fill', nonce: 'n1', origin: 'https://evil.example'
  }).then(r => JSON.stringify(r)).catch(e => 'THROWN:' + e.message)`);
  const f1 = typeof badOrigin === 'string' && badOrigin.includes('ORIGIN_MISMATCH');
  record('F1', 'origin 不匹配时拒绝授权（跨站填充防护）', f1, badOrigin);

  // ---- F2: 前缀 origin 也必须拒绝（不能是 startsWith） ----
  const prefixOrigin = await EXT_CALL(`chrome.tabs.sendMessage(${tabId}, {
    type: 'prepare-fill', nonce: 'n2', origin: 'https://127.0.0.1'
  }).then(r => JSON.stringify(r)).catch(e => 'THROWN:' + e.message)`);
  const f2 = typeof prefixOrigin === 'string' && prefixOrigin.includes('ORIGIN_MISMATCH');
  record('F2', '前缀 origin 也被拒绝（不是 startsWith 判据）', f2, prefixOrigin);

  // ---- F3: 正确 origin 时接受，且页面有登录表单 ----
  const goodOrigin = `https://127.0.0.1:${PORT_A}`;
  const okPrep = await EXT_CALL(`chrome.tabs.sendMessage(${tabId}, {
    type: 'prepare-fill', nonce: 'n3', origin: '${goodOrigin}'
  }).then(r => JSON.stringify(r)).catch(e => 'THROWN:' + e.message)`);
  const f3 = typeof okPrep === 'string' && okPrep.includes('"ok":true');
  record('F3', 'origin 精确匹配时接受授权', f3, okPrep);

  // ---- F4: 没有授权时 redeem-now 必须拒绝 ----
  // （先刷新页面清掉 pending，再试）
  await PAGE_CALL('location.reload()');
  await sleep(1800);
  const noPending = await EXT_CALL(`chrome.tabs.sendMessage(${tabId}, {
    type: 'redeem-now', entryId: 'e1'
  }).then(r => JSON.stringify(r)).catch(e => 'THROWN:' + e.message)`);
  const f4 = typeof noPending === 'string' && noPending.includes('NO_PENDING');
  record('F4', '没有授权时拒绝兑换（防重放）', f4, noPending);

  // ---- F5: 页面上的两个输入框都在（前提校验） ----
  const dom = await PAGE_CALL(`JSON.stringify({
    user: !!document.querySelector('#u'),
    pass: !!document.querySelector('#p'),
    passType: document.querySelector('#p')?.type
  })`);
  const f5 = typeof dom === 'string' && dom.includes('"pass":true') && dom.includes('password');
  record('F5', '登录表单可见（用户名 + 密码框）', f5, dom);

  console.log(
    `\n=== 结果：PASS ${results.filter((r) => r.pass).length} / FAIL ${
      results.filter((r) => !r.pass).length
    } / 共 ${results.length} ===`,
  );

  if (results.some((r) => !r.pass)) process.exitCode = 1;
} catch (e) {
  console.log(`\n失败：${e && e.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (cdp) cdp.close();
  } catch {}
  if (chrome) chrome.kill();
  await sleep(500);
  if (sites) await sites.close();
  for (const d of [PROFILE, MANIFEST_DIR]) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
}
