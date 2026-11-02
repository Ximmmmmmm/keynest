// KeyNest 浏览器桥 · 真实 Chrome 验收（阶段 2.7.4）
//
// 目的：复验阶段 2.7.3 的看门狗修复，并补齐阶段 2.7.2 遗留的三项
//   T7  并发兑换（真实 SW 内 100 并发，只应成功 1 次）
//   T8b 跨 origin 查询不返回他站条目
//   T5e Tab 关闭后旧授权失效
//
// # 为什么要有两套上下文
//
// 扩展的 SW 用 `classifySender` 区分三种来源，判据是 `sender.id` + `sender.url`：
//   * `popup`   —— 扩展自己的特权页（popup.html）
//   * `content` —— 网页里的 content script（sender.tab 存在）
//   * `unknown` —— 其余，**包括 SW 自己发给自己的消息**
//
// 所以 `query` / `authorize-fill` 必须从 popup.html 这个真实页面上下文发起，
// `redeem-fill` 必须从 content script 的隔离世界发起。
// 在 SW 里直接 sendMessage 给自己会被判成 unknown，一律 PRIVILEGED_ONLY / CONTENT_ONLY。
// 这不是测试取巧——它正是产品真实的消息来源模型。
//
// 全部在临时目录、临时 Chrome profile、临时密码库上跑。
// 结束时统一清理，并核对真实库 size/mtime/md5 未变。
//
// 用法：node test/acceptance/run.mjs
//   KN_KEEP=1  保留临时目录（排错用）

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

import { Cdp, browserWsUrl, waitFor } from './lib/cdp.mjs';
import { startSites } from './lib/site.mjs';
import {
  CHROME,
  EXT_DIR,
  REPO,
  ensureCert,
  guiLog,
  killAll,
  makeRoots,
  registryState,
  registerHost,
  resetRoots,
  seedVault,
  startGui,
  unregisterHost,
  unlockGui,
  waitFile,
} from './lib/env.mjs';

const MASTER = 'p274-test-master';
const PORT_A = 9445;
const PORT_B = 9446;
const PORT_HTTP = 9447;
const CDP_PORT = 9334;
const NL = String.fromCharCode(10);

const results = [];

function record(id, title, status, note) {
  results.push({ id, title, status, note: note ?? null });
  process.stdout.write(`  ${id.padEnd(6)} ${status.padEnd(5)} ${title}${note ? ` — ${note}` : ''}${NL}`);
  return status === 'PASS';
}

/** 真实库指纹：只读 size/mtime/md5，不解析内容。 */
function realVaultFingerprint() {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'KeyNest', 'vault.dat'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'KeyNest', 'vault.dat'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return { path: null };
  const st = fs.statSync(found);
  return {
    path: found,
    size: st.size,
    mtimeMs: st.mtimeMs,
    md5: createHash('md5').update(fs.readFileSync(found)).digest('hex'),
  };
}

async function evalIn(cdp, sessionId, expression, contextId) {
  const params = { expression, awaitPromise: true, returnByValue: true, userGesture: true };
  if (contextId) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'EVAL_FAILED');
  }
  return r.result?.value;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { sessionId, call: (expr, ctx) => evalIn(cdp, sessionId, expr, ctx) };
}

/**
 * 等 content script 的隔离世界出现，返回它的 executionContextId。
 *
 * 为什么必须精确切进去：`redeem-fill` 只接受 content script 发来的消息，
 * 而 content script 跑在 isolated world（main world 里没有 `chrome.runtime` 的
 * 那一套扩展 API）。在主世界 evaluate 会拿到 "chrome.runtime is undefined"。
 */
async function awaitIsolatedWorld(cdp, sessionId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, 15000);
    const off = cdp.on('Runtime.executionContextCreated', (p, sid) => {
      if (sid !== sessionId) return;
      const c = p.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.name === 'KeyNest') {
        clearTimeout(timer);
        off();
        resolve(c.id);
      }
    });
  });
}

/**
 * 找出 origin 匹配的 tabId。
 *
 * 扩展只有 activeTab 权限：`tabs.query({url})` 既过滤不到也读不到 url。
 * 但 SW 的 `query` 回包带 origin（来源是 getFrame，可信），
 * 所以从 popup 上下文对每个 tabId 各问一次——顺带验了「query 只返回本 origin 的条目」。
 */
async function findTabByOrigin(popup, want) {
  const ids = await popup.call('chrome.tabs.query({}).then(t => t.map(x => x.id))');
  for (const id of ids || []) {
    const r = await popup
      .call(`chrome.runtime.sendMessage({ type: 'query', tabId: ${id} })`)
      .catch(() => null);
    if (r && r.ok && r.origin === want) return { id, origin: r.origin, res: r };
  }
  return null;
}

async function main() {
  const dirs = makeRoots('kn274');
  const realBefore = realVaultFingerprint();
  const regBefore = registryState();

  process.stdout.write(`=== 阶段 2.7.4 · 真实 Chrome 验收 ===${NL}`);
  process.stdout.write(`临时目录   ${dirs.root}${NL}`);
  process.stdout.write(
    `真实库     ${realBefore.path ? `${realBefore.size} B md5=${realBefore.md5}` : '不存在'}${NL}`
  );
  process.stdout.write(`注册项(前) chrome=${regBefore.chrome} edge=${regBefore.edge}${NL}${NL}`);

  resetRoots(dirs);
  ensureCert(dirs);

  let sites = null;
  let cdp = null;
  let extensionId = null;

  try {
    const vaultPath = seedVault(dirs, MASTER, `https://127.0.0.1:${PORT_A}`);
    process.stdout.write(`临时库     ${vaultPath}${NL}`);

    const chrome = spawn(
      CHROME,
      [
        `--user-data-dir=${dirs.profile}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--ignore-certificate-errors',
        '--allow-insecure-localhost',
        'about:blank',
      ],
      { stdio: 'ignore', detached: true, env: { ...process.env, KEYNEST_DATA_DIR: dirs.data } }
    );
    chrome.unref();

    cdp = await Cdp.connect(await browserWsUrl(CDP_PORT), { timeoutMs: 20000 });

    // 真实 chrome://extensions 通路加载未打包扩展（不靠命令行 --load-extension）
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    extensionId = loaded.id;
    process.stdout.write(`扩展       ${extensionId}${NL}`);

    registerHost({ manifestDir: dirs.manifest, chromeId: extensionId });
    process.stdout.write(`Host 清单  ${path.join(dirs.manifest, 'com.keynest.bridge.json')}${NL}`);

    sites = await startSites({ certDir: dirs.site, portA: PORT_A, portB: PORT_B });
    process.stdout.write(`站点       https://127.0.0.1:${PORT_A}/ + https://localhost:${PORT_B}/${NL}${NL}`);

    // ---------- GUI 解锁 ----------
    startGui(dirs);
    await sleep(3000);
    const unlock = unlockGui(dirs, MASTER);
    const keyed = await waitFile(path.join(dirs.data, 'bridge.key'), 15000);
    if (
      !record(
        'T0',
        'GUI 解锁并启动桥接（bridge.key 生成）',
        keyed ? 'PASS' : 'FAIL',
        `unlock=${unlock.out}`
      )
    ) {
      process.stdout.write(`${NL}GUI 日志:${NL}${guiLog(dirs)}${NL}`);
      throw new Error('GUI 未解锁');
    }

    // ---------- 站点 A ----------
    const { targetId: tabA } = await cdp.send('Target.createTarget', {
      url: `https://127.0.0.1:${PORT_A}/`,
    });
    const pageA = await attach(cdp, tabA);
    await waitFor(async () => (await pageA.call('document.readyState')) === 'complete', {
      label: 'site A load',
    });
    const ctxPromise = awaitIsolatedWorld(cdp, pageA.sessionId);
    await cdp.send('Runtime.enable', {}, pageA.sessionId).catch(() => {});
    const contentCtx = await ctxPromise;
    record(
      'T5a',
      'content script 注入到主 frame 的隔离世界',
      typeof contentCtx === 'number' ? 'PASS' : 'FAIL',
      `contextId=${contentCtx}`
    );

    // ---------- popup 特权上下文 ----------
    const { targetId: popupTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
    });
    const popup = await attach(cdp, popupTarget);
    await waitFor(async () => (await popup.call('document.readyState')) === 'complete', {
      label: 'popup load',
    });
    await sleep(700);

    // ---------- T1 定位 tab ----------
    const knTab = await findTabByOrigin(popup, `https://127.0.0.1:${PORT_A}`);
    record(
      'T1',
      '从 popup 上下文定位测试 tab 并读到 origin',
      knTab ? 'PASS' : 'FAIL',
      knTab ? `tabId=${knTab.id} origin=${knTab.origin}` : '未找到'
    );
    if (!knTab) throw new Error('找不到目标 tab');

    // ---------- T2 status ----------
    const status = await popup.call(`chrome.runtime.sendMessage({ type: 'status' })`);
    record(
      'T2',
      'Native Messaging 握手 + status（未锁定）',
      status && status.ok && status.data && status.data.locked === false ? 'PASS' : 'FAIL',
      JSON.stringify(status)
    );

    // ---------- T3 query（不含密码）----------
    const q = await popup.call(
      `chrome.runtime.sendMessage({ type: 'query', tabId: ${knTab.id} })`
    );
    const leaks = q && q.ok && q.entries.some((e) => 'password' in e);
    record(
      'T3',
      'vault.query 返回条目且不含 password 字段',
      q && q.ok && !leaks ? 'PASS' : 'FAIL',
      q && q.ok ? `entries=${q.entries.length}` : JSON.stringify(q)
    );
    const entryId = q && q.ok && q.entries[0] ? q.entries[0].id : null;
    if (!entryId) throw new Error('临时库里没有匹配条目');

    // ---------- T6 空闲不超时（阶段 2.7.3 的核心验收）----------
    // 复现修复前的真实故障：用户点开扩展后犹豫几秒，连接就被看门狗当「请求超时」断开，
    // 之后所有请求都 HOST_DISCONNECTED。这里显式空闲 6 秒（远大于 3 秒阈值），
    // 再发同一个请求，必须仍然成功。
    await sleep(6000);
    const afterIdle = await popup.call(
      `chrome.runtime.sendMessage({ type: 'status' })`
    );
    record(
      'T6',
      '客户端空闲 6 秒后仍能正常通信（看门狗不再把空闲当超时）',
      afterIdle && afterIdle.ok && afterIdle.data && afterIdle.data.locked === false
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(afterIdle)
    );

    // 空闲后再来一次真实查询，确认不是只有 status 走运
    const afterIdle2 = await popup.call(
      `chrome.runtime.sendMessage({ type: 'query', tabId: ${knTab.id} })`
    );
    record(
      'T6b',
      '空闲后再次查询仍返回条目（连接未被断开）',
      afterIdle2 && afterIdle2.ok && afterIdle2.entries.length > 0 ? 'PASS' : 'FAIL',
      afterIdle2 && afterIdle2.ok ? `entries=${afterIdle2.entries.length}` : JSON.stringify(afterIdle2)
    );

    // ---------- T8b 跨 origin 查询 ----------
    const { targetId: tabB } = await cdp.send('Target.createTarget', {
      url: `https://localhost:${PORT_B}/`,
    });
    const pageB = await attach(cdp, tabB);
    await waitFor(async () => (await pageB.call('document.readyState')) === 'complete', {
      label: 'site B load',
    });
    await sleep(900);
    const knTabB = await findTabByOrigin(popup, `https://localhost:${PORT_B}`);
    const qCross = knTabB
      ? await popup.call(`chrome.runtime.sendMessage({ type: 'query', tabId: ${knTabB.id} })`)
      : { ok: false, error: 'NO_TAB_B' };
    // 判据是「一个 A 站的条目都不许出现」，不是「必须返回 0 条」：
    // 夹具库里在 localhost:9446 上本来就有条目，返回它才是精确 origin 匹配的正确行为。
    const crossLeak =
      qCross && Array.isArray(qCross.entries)
        ? qCross.entries.filter((e) => e.url.includes('127.0.0.1:' + PORT_A))
        : ['no-entries'];
    record(
      'T8b',
      '跨 origin 查询不返回 A 站条目（精确 origin 匹配）',
      qCross && qCross.ok && crossLeak.length === 0 ? 'PASS' : 'FAIL',
      JSON.stringify(qCross)
    );

    // ---------- T7 并发兑换（真实 SW 内 100 并发）----------
    const auth = await popup.call(
      `chrome.runtime.sendMessage({ type: 'authorize-fill', tabId: ${knTab.id}, entryId: ${JSON.stringify(entryId)} })`
    );
    const nonce = auth && auth.ok ? auth.nonce : null;
    record(
      'T7a',
      'authorize-fill 签发一次性 nonce（32 hex）',
      nonce && /^[0-9a-f]{32}$/.test(nonce) ? 'PASS' : 'FAIL',
      nonce ? `${nonce.slice(0, 8)}…` : JSON.stringify(auth)
    );

    if (nonce) {
      const conc = await pageA.call(
        `(async () => {
           const n = ${JSON.stringify(nonce)};
           const eid = ${JSON.stringify(entryId)};
           const one = () => chrome.runtime.sendMessage({ type: 'redeem-fill', nonce: n, entryId: eid });
           const out = await Promise.all(Array.from({ length: 100 }, one));
           const codes = {};
           for (const x of out) {
             const k = x && x.ok ? 'OK' : 'REJ:' + ((x && x.error) || 'unknown');
             codes[k] = (codes[k] || 0) + 1;
           }
           const winner = out.find((x) => x && x.ok);
           return {
             okCount: out.filter((x) => x && x.ok).length,
             total: out.length,
             codes,
             winnerPwLen: winner && typeof winner.password === 'string' ? winner.password.length : 0,
           };
         })()`,
        contentCtx
      );
      record(
        'T7',
        '真实 SW 内 100 并发兑换只成功 1 次且只取到 1 份密码',
        conc && conc.okCount === 1 && conc.winnerPwLen > 0 ? 'PASS' : 'FAIL',
        JSON.stringify(conc)
      );

      const again = await pageA.call(
        `chrome.runtime.sendMessage({ type: 'redeem-fill', nonce: ${JSON.stringify(nonce)}, entryId: ${JSON.stringify(entryId)} })`,
        contentCtx
      );
      record(
        'T7c',
        '同一 nonce 重复兑换被拒（一次性）',
        again && again.ok === false ? 'PASS' : 'FAIL',
        JSON.stringify(again)
      );
    }

    // ---------- T7d 真实用户路径：authorize → redeem-now → 页面被填 ----------
    const auth2 = await popup.call(
      `chrome.runtime.sendMessage({ type: 'authorize-fill', tabId: ${knTab.id}, entryId: ${JSON.stringify(entryId)} })`
    );
    let doFill = null;
    if (auth2 && auth2.ok) {
      doFill = await popup.call(
        `chrome.tabs.sendMessage(${knTab.id}, { type: 'redeem-now', entryId: ${JSON.stringify(entryId)} }, { frameId: 0 })`
      );
    }
    const filled = await pageA.call(
      `(() => {
         const u = document.getElementById('u');
         const p = document.getElementById('p');
         return { user: u ? u.value : null, pwLen: p && p.value ? p.value.length : 0 };
       })()`
    );
    record(
      'T7d',
      '真实用户路径（authorize → redeem-now）后页面输入框被填充',
      doFill && doFill.ok && filled && filled.pwLen > 0 ? 'PASS' : 'FAIL',
      `send=${JSON.stringify(doFill)} dom=${JSON.stringify(filled)}`
    );
    // 复原表单，避免后续用例读到旧值
    await pageA.call(
      `(() => { const u = document.getElementById('u'); const p = document.getElementById('p');
                if (u) u.value = ''; if (p) p.value = ''; return true; })()`
    );

    // ---------- T7e 带 username 的授权：用户名也要被填 ----------
    // T7d 没传 username，所以用户名字段按设计故意不动（避免清掉用户已输入的账号）。
    // 这里补上 popup 真实会传的那个值（`doFill(entry.id, entry.username)`），
    // 验证 username 链路也是通的。
    //
    // 为什么不是「点 popup 里的列表项」：popup.html 作为标签页打开时，
    // `chrome.tabs.query({active:true,currentWindow:true})` 解析到的是它**自己**那个标签页，
    // 从而 query 必然 NO_ORIGIN、列表渲染不出来。要绕开就得给它塞一个假的 tabs.query，
    // 那就变成测 mock 了，比不测更糟。所以这里只跳过「DOM 点击」这一层，
    // 调用的仍是 popup 实际发出的同一条消息。
    const uname = q.entries[0].username;
    const authU = await popup.call(
      `chrome.runtime.sendMessage({ type: 'authorize-fill', tabId: ${knTab.id}, entryId: ${JSON.stringify(entryId)}, username: ${JSON.stringify(uname)} })`
    );
    let fillU = null;
    if (authU && authU.ok) {
      fillU = await popup.call(
        `chrome.tabs.sendMessage(${knTab.id}, { type: 'redeem-now', entryId: ${JSON.stringify(entryId)} }, { frameId: 0 })`
      );
    }
    const filledU = await pageA.call(
      `(() => {
         const u = document.getElementById('u');
         const p = document.getElementById('p');
         return { user: u ? u.value : null, pwLen: p && p.value ? p.value.length : 0 };
       })()`
    );
    record(
      'T7e',
      '携带 username 的授权：用户名与密码都被填入页面',
      fillU && fillU.ok && filledU && filledU.pwLen > 0 && filledU.user === uname ? 'PASS' : 'FAIL',
      `send=${JSON.stringify(fillU)} dom=${JSON.stringify(filledU)} expectUser=${JSON.stringify(uname)}`
    );
    await pageA.call(
      `(() => { const u = document.getElementById('u'); const p = document.getElementById('p');
                if (u) u.value = ''; if (p) p.value = ''; return true; })()`
    );

    // ---------- T5e Tab 关闭后授权失效 ----------
    const auth3 = await popup.call(
      `chrome.runtime.sendMessage({ type: 'authorize-fill', tabId: ${knTab.id}, entryId: ${JSON.stringify(entryId)} })`
    );
    const nonce3 = auth3 && auth3.ok ? auth3.nonce : null;
    let closedOut = null;
    if (nonce3) {
      await cdp.send('Target.closeTarget', { targetId: tabA });
      await sleep(900);
      // tab 已关：content script 随之消失，从 popup 发 redeem-fill 会被
      // CONTENT_ONLY 拦下 —— 那不是我们要验的。
      // 真正要验的是「授权记录是否已随 tab 消失」，所以从 popup 换一个
      // 仍然存活的 content 上下文（站点 B）去兑换，nonce 绑定的 tab 已不在 → 必须拒绝。
      // 先在站 B 上把隔离世界拿到手（Runtime.enable 会补发已存在的 context）
      const bCtxPromise = awaitIsolatedWorld(cdp, pageB.sessionId);
      await cdp.send('Runtime.enable', {}, pageB.sessionId).catch(() => {});
      const ctxB = await bCtxPromise;
      closedOut = await pageB.call(
        `chrome.runtime.sendMessage({ type: 'redeem-fill', nonce: ${JSON.stringify(nonce3)}, entryId: ${JSON.stringify(entryId)} })`,
        ctxB ?? undefined
      );
    }
    record(
      'T5e',
      'Tab 关闭后旧授权失效',
      closedOut && closedOut.ok === false ? 'PASS' : 'FAIL',
      JSON.stringify(closedOut)
    );

    // ---------- T9 网页上下文拿不到 chrome.storage ----------
    const storage = await pageB.call(
      `({ runtime: typeof chrome === 'object' && chrome !== null ? 'runtime' in chrome : null,
          storage: typeof chrome === 'object' && chrome !== null ? 'storage' in chrome : null,
          ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) })`
    );
    record(
      'T9',
      '主世界拿不到 chrome.storage，web storage 为空',
      storage &&
        // 主世界里 chrome 对象上只有少量成员，没有 storage
        !storage.storage &&
        storage.ls.length === 0 &&
        storage.ss.length === 0
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(storage)
    );

    // ---------- T10 设置页（模块注册表 UI）----------
    const { targetId: optTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const options = await attach(cdp, optTarget);
    await waitFor(async () => (await options.call('document.readyState')) === 'complete', {
      label: 'options load',
    });
    // 页面自己会发 modules.list 并渲染，等它渲染出至少两张卡片
    const optsState = await waitFor(
      async () =>
        options.call(`(() => {
          const cards = document.querySelectorAll('#modules .module');
          const err = document.getElementById('error');
          return {
            cards: cards.length,
            summary: document.getElementById('summary').textContent,
            error: err && !err.classList.contains('hidden') ? err.textContent : null,
            perms: document.getElementById('perm-diff').textContent,
          };
        })()`).then((v) => (v && v.cards >= 2 ? v : null)),
      { label: 'options rendered', timeoutMs: 12000 }
    );
    record(
      'T10',
      '设置页渲染出模块列表（含权限自述）',
      optsState && optsState.cards >= 2 && !optsState.error ? 'PASS' : 'FAIL',
      JSON.stringify(optsState)
    );

    // 设置页能看到核心模块被标记为不可关闭
    const coreTags = await options.call(
      `Array.from(document.querySelectorAll('#modules .badge-required')).map(e => e.textContent)`
    );
    record(
      'T10b',
      '核心模块在设置页标记为不可关闭',
      Array.isArray(coreTags) && coreTags.length === 2 ? 'PASS' : 'FAIL',
      JSON.stringify(coreTags)
    );

    // ---------- T8c 错误 entryId ----------
    const badAuth = await popup.call(
      `chrome.runtime.sendMessage({ type: 'authorize-fill', tabId: ${knTabB.id}, entryId: 'nonexistent-entry' })`
    );
    record(
      'T8c',
      '错误 entryId 被拒绝（ENTRY_NOT_MATCHED）',
      badAuth && badAuth.ok === false && badAuth.error === 'ENTRY_NOT_MATCHED' ? 'PASS' : 'FAIL',
      JSON.stringify(badAuth)
    );

    // ---------- T8d HTTP 页面拒绝 ----------
    const httpSrv = spawn(
      process.execPath,
      [
        '-e',
        "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<input type=password id=p>')}).listen(" +
          PORT_HTTP +
          ",'127.0.0.1')",
      ],
      { stdio: 'ignore' }
    );
    await sleep(1000);
    const { targetId: tabHttp } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${PORT_HTTP}/`,
    });
    const pageHttp = await attach(cdp, tabHttp);
    await waitFor(async () => (await pageHttp.call('document.readyState')) === 'complete', {
      label: 'http page load',
    });
    await sleep(900);
    const idsHttp = await popup.call('chrome.tabs.query({}).then(t => t.map(x => x.id))');
    let httpQuery = { ok: false, error: 'NO_TAB_HTTP' };
    for (const id of idsHttp || []) {
      const r = await popup
        .call(`chrome.runtime.sendMessage({ type: 'query', tabId: ${id} })`)
        .catch(() => null);
      if (r && r.ok === false && r.error === 'HTTP_NOT_ALLOWED') {
        httpQuery = r;
        break;
      }
    }
    record(
      'T8d',
      'HTTP 页面被拒绝（HTTP_NOT_ALLOWED）',
      httpQuery && httpQuery.error === 'HTTP_NOT_ALLOWED' ? 'PASS' : 'FAIL',
      JSON.stringify(httpQuery)
    );
    httpSrv.kill();
  } finally {
    process.stdout.write(`${NL}=== 清理 ===${NL}`);
    try {
      sites?.close();
    } catch {
      /* 已关闭 */
    }
    try {
      cdp?.close();
    } catch {
      /* 已关闭 */
    }
    killAll();
    await sleep(800);
    if (extensionId) unregisterHost({ manifestDir: dirs.manifest });

    const regAfter = registryState();
    const realAfter = realVaultFingerprint();
    const realOk =
      (!realBefore.path && !realAfter.path) ||
      (realBefore.size === realAfter.size &&
        realBefore.md5 === realAfter.md5 &&
        realBefore.mtimeMs === realAfter.mtimeMs);

    process.stdout.write(`注册项(后) chrome=${regAfter.chrome} edge=${regAfter.edge}${NL}`);
    process.stdout.write(
      `真实库     ${realAfter.path ? `${realAfter.size} B md5=${realAfter.md5}` : '不存在'} → ${realOk ? '未变' : '已变化（异常）'}${NL}`
    );

    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    process.stdout.write(`${NL}=== 结果 === PASS ${pass} / FAIL ${fail} / 共 ${results.length}${NL}`);

    if (process.env.KN_KEEP) {
      process.stdout.write(`保留临时目录 ${dirs.root}${NL}`);
    } else {
      try {
        fs.rmSync(dirs.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      } catch (e) {
        process.stdout.write(`临时目录清理失败（进程仍占用）: ${e.code}${NL}`);
      }
    }

    const outDir = path.join(REPO, 'test/acceptance/.out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'phase274.json'),
      JSON.stringify(
        {
          when: new Date().toISOString(),
          extensionId,
          results,
          registry: { before: regBefore, after: regAfter },
          realVault: { before: realBefore, after: realAfter, unchanged: realOk },
          guiLogTail: guiLog(dirs).split(NL).slice(-30).join(NL),
        },
        null,
        2
      )
    );

    if (fail > 0 || !realOk) process.exitCode = 1;
  }
}

await main();
