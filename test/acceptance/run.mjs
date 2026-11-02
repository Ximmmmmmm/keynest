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

    // 真实输入自动化有时序抖动（egui 首帧布局、前台锁竞争）。
    // 重试一次比让整轮验收作废更合适——但也只重试一次：
    // 连续两次失败说明是真的问题，不该用重试掩盖。
    let unlock = unlockGui(dirs, MASTER);
    let keyed = await waitFile(path.join(dirs.data, 'bridge.key'), 15000);
    if (!keyed) {
      process.stdout.write(`  （首次解锁未成功：${unlock.out}，重试一次）${NL}`);
      await sleep(800);
      unlock = unlockGui(dirs, MASTER);
      keyed = await waitFile(path.join(dirs.data, 'bridge.key'), 20000);
    }
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
        // 每个字段都要自己容错：页面还没渲染完时元素可能都还不存在，
        // 让 probe 抛异常会把 waitFor 直接打断，看不到"其实马上就绪了"。
        options.call(`(() => {
          const cards = document.querySelectorAll('#modules .module');
          const err = document.getElementById('error');
          const sum = document.getElementById('summary');
          const pd = document.getElementById('perm-diff');
          return {
            cards: cards.length,
            summary: sum ? sum.textContent : '',
            error: err && !err.classList.contains('hidden') ? err.textContent : null,
            perms: pd ? pd.textContent : '',
          };
        })()`).catch(() => null).then((v) => (v && v.cards >= 2 ? v : null)),
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

    // ---------- T11 广告过滤：真实 dNR 规则安装 ----------
    // 这一项验的是「模块真的把规则装进了浏览器」，不是"规则算对了"。
    // 后者在 node 测试里覆盖（tests/filters.test.js 32 项 + tests/adblock.test.js 23 项）。

    // 前置：adblock 默认关闭，必须先经设置页正规开关打开。
    // 这一步顺带验了「禁用模块的消息真的被拦」——直接调 adblock.apply 会拿到
    // MODULE_DISABLED，说明模块开关不是装饰。
    const blockedWhileDisabled = await options.call(
      `chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'basic' })`
    );
    record(
      'T11pre',
      '广告过滤默认关闭时，其消息被 MODULE_DISABLED 拦下',
      blockedWhileDisabled && blockedWhileDisabled.ok === false &&
        blockedWhileDisabled.error === 'MODULE_DISABLED'
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(blockedWhileDisabled)
    );

    const enableAdblock = await options.call(
      `chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'adblock', enabled: true })`
    );
    record(
      'T11pre2',
      '通过设置页接口启用广告过滤',
      enableAdblock && enableAdblock.ok ? 'PASS' : 'FAIL',
      JSON.stringify(enableAdblock)
    );

    const applyBasic = await options.call(
      `chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'basic' })`
    );
    const rulesBasic = await options.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r => ({
         count: r.length,
         types: [...new Set(r.map(x => x.action.type))].sort(),
         maxPriority: Math.max(0, ...r.map(x => x.priority)),
       }))`
    );
    record(
      'T11',
      '广告过滤 basic 档：真实安装动态规则',
      applyBasic && applyBasic.ok && rulesBasic && rulesBasic.count > 0
        ? 'PASS'
        : 'FAIL',
      `apply=${JSON.stringify(applyBasic)} installed=${JSON.stringify(rulesBasic)}`
    );

    // ---------- T11b strict 档规则更多且含 redirect ----------
    const applyStrict = await options.call(
      `chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'strict' })`
    );
    const rulesStrict = await options.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r => ({
         count: r.length,
         types: [...new Set(r.map(x => x.action.type))].sort(),
       }))`
    );
    record(
      'T11b',
      'strict 档规则数更多，且包含跟踪参数剔除（redirect）',
      applyStrict && applyStrict.ok &&
        rulesStrict &&
        rulesStrict.count > rulesBasic.count &&
        rulesStrict.types.includes('redirect')
        ? 'PASS'
        : 'FAIL',
      `apply=${JSON.stringify(applyStrict)} installed=${JSON.stringify(rulesStrict)}`
    );

    // ---------- T11c off 档真的清空 ----------
    const applyOff = await options.call(
      `chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'off' })`
    );
    const rulesOff = await options.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)`
    );
    record(
      'T11c',
      'off 档清空全部动态规则（不是"有规则但不生效"）',
      applyOff && applyOff.ok && rulesOff === 0 ? 'PASS' : 'FAIL',
      `remaining=${rulesOff}`
    );

    // ---------- T11d 豁免域名提升为 allowAllRequests 且优先级最高 ----------
    const applyAllow = await options.call(
      `chrome.runtime.sendMessage({
         type: 'adblock.apply', mode: 'basic', allowDomains: ['localhost']
       })`
    );
    const allowRules = await options.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r => r
         .filter(x => x.action.type === 'allowAllRequests')
         .map(x => ({ pri: x.priority, domains: x.condition.requestDomains })))`
    );
    record(
      'T11d',
      '豁免域名生成 allowAllRequests 规则',
      applyAllow && applyAllow.ok &&
        Array.isArray(allowRules) &&
        allowRules.length === 1 &&
        allowRules[0].domains.includes('localhost')
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(allowRules)
    );

    // 复原：把过滤关掉，避免影响后续用例
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'off' })`);

    // ---------- T12 配置持久化（阶段 3.0）----------
    // 关键点：不是"能写能读"，而是**跨上下文持久**。
    // 在 options 页面写，在另一个扩展页面（popup）读回来 —— 这才是 SW 重启后的语义。
    const writeRes = await options.call(
      `chrome.storage.local.set({
         'keynest.cfg.adblock': { enabled: true, mode: 'strict' },
       }).then(() => chrome.storage.local.get('keynest.cfg.adblock'))`
    );
    const persisted = await popup.call(
      `chrome.storage.local.get('keynest.cfg.adblock').then(g => g['keynest.cfg.adblock'])`
    );
    record(
      'T12',
      '配置跨上下文持久（options 写 → popup 读回）',
      persisted && persisted.mode === 'strict' ? 'PASS' : 'FAIL',
      `write=${JSON.stringify(writeRes)} read=${JSON.stringify(persisted)}`
    );

    // ---------- T12b 存储审计：没有敏感键 ----------
    const audit = await popup.call(
      `chrome.storage.local.get(null).then(all => {
         const keys = Object.keys(all);
         const SUSPECT = ['password','secret','token','apikey','masterkey','nonce','cookie','bridge.key'];
         const walk = (path, v, hits) => {
           if (v && typeof v === 'object') {
             for (const [k, vv] of Object.entries(v)) walk(path ? path + '.' + k : k, vv, hits);
           } else if (path && SUSPECT.some(s => path.toLowerCase().includes(s))) {
             hits.push(path);
           }
         };
         const hits = [];
         for (const k of keys) walk(k, all[k], hits);
         return { keys, hits };
       })`
    );
    record(
      'T12b',
      '扩展存储里没有任何敏感键（密码/密钥/令牌/nonce/cookie）',
      audit && Array.isArray(audit.hits) && audit.hits.length === 0 ? 'PASS' : 'FAIL',
      JSON.stringify(audit)
    );

    // ---------- T12c 数据只落 storage.local，不落 sync ----------
    // 注意：`chrome.storage.sync` 这个**对象**在声明了 storage 权限后永远存在，
    // 所以"有没有 sync API"不是判据。真正的判据是 sync 区里有没有我们的键——
    // 有就说明有人往云端写了数据，那与"本地密码管理器"的定位直接冲突。
    const syncScope = await popup.call(
      `chrome.storage.sync.get(null).then(g => ({
         syncKeys: Object.keys(g || {}).filter(k => k.startsWith('keynest.')),
         syncQuota: chrome.storage.sync.QUOTA_BYTES,
         localHasData: chrome.storage.local.get(null).then(a => Object.keys(a || {}).length),
       }))`
    );
    record(
      'T12c',
      'keynest 的键只写在 storage.local，sync 区为空（数据不出本机）',
      syncScope && Array.isArray(syncScope.syncKeys) && syncScope.syncKeys.length === 0
        ? 'PASS'
        : 'FAIL',
      JSON.stringify(syncScope)
    );

    // 清掉测试写入的配置，避免污染后续
    await options.call(`chrome.storage.local.remove('keynest.cfg.adblock')`);

    // ---------- T13 按站点暂停（popup 入口的模块层行为）----------
    // 先启用广告过滤并装 basic 规则
    await options.call(
      `chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'adblock', enabled: true })`
    );
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'basic' })`);

    const allowRes = await popup.call(
      `chrome.runtime.sendMessage({ type: 'adblock.allow', domain: 'example.test' })`
    );
    const afterAllow = await popup.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r =>
         r.filter(x => x.action.type === 'allowAllRequests')
          .map(x => x.condition.requestDomains[0]))`
    );
    record(
      'T13',
      '在站点暂停：写入豁免名单并立即生成 allowAllRequests 规则',
      allowRes && allowRes.ok &&
        Array.isArray(afterAllow) && afterAllow.includes('example.test')
        ? 'PASS'
        : 'FAIL',
      `res=${JSON.stringify(allowRes)} allows=${JSON.stringify(afterAllow)}`
    );

    // ---------- T13b 子域归属：豁免 example.test 也覆盖 www.example.test ----------
    const subCheck = await popup.call(
      `chrome.runtime.sendMessage({ type: 'adblock.check', host: 'www.example.test' })`
    );
    const otherCheck = await popup.call(
      `chrome.runtime.sendMessage({ type: 'adblock.check', host: 'notexample.test' })`
    );
    record(
      'T13b',
      '豁免按域名归属生效：子域被覆盖，相似域名不被覆盖',
      subCheck && subCheck.ok && subCheck.allowed === true &&
        otherCheck && otherCheck.ok && otherCheck.allowed === false
        ? 'PASS'
        : 'FAIL',
      `sub=${JSON.stringify(subCheck)} other=${JSON.stringify(otherCheck)}`
    );

    // ---------- T13c 恢复过滤：规则被移除 ----------
    const disallowRes = await popup.call(
      `chrome.runtime.sendMessage({ type: 'adblock.disallow', domain: 'example.test' })`
    );
    const afterDisallow = await popup.call(
      `chrome.declarativeNetRequest.getDynamicRules().then(r =>
         r.filter(x => x.action.type === 'allowAllRequests').length)`
    );
    record(
      'T13c',
      '恢复过滤：豁免规则被移除',
      disallowRes && disallowRes.ok && afterDisallow === 0 ? 'PASS' : 'FAIL',
      `res=${JSON.stringify(disallowRes)} remainingAllows=${afterDisallow}`
    );

    // ---------- T13d 豁免名单持久化（跨上下文）----------
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.allow', domain: 'persist.test' })`);
    const persistedList = await popup.call(
      `chrome.storage.local.get('keynest.cfg.adblock').then(g => {
         const v = g['keynest.cfg.adblock'];
         return v ? v.allowlist : null;
       })`
    );
    record(
      'T13d',
      '豁免名单写进 storage（跨上下文可见）',
      typeof persistedList === 'string' && persistedList.includes('persist.test') ? 'PASS' : 'FAIL',
      `stored=${JSON.stringify(persistedList)}`
    );

    // 复原：清掉豁免与规则
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.disallow', domain: 'persist.test' })`);
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'off' })`);

    // ---------- T15 阅读模式：真实注入到真实页面 ----------
    // 前置：授予 host 权限。
    //
    // `https://*/*` 在 manifest 里是 **optional** 的（安装时不弹窗），
    // 所以 executeScript 前必须先 request 一次——这正是阅读模式模块里的
    // ensureHostPermission 在做的事。这里模拟那次授权。
    const grant = await options.call(
      `chrome.permissions.request({ origins: ['https://*/*'] })`
    );
    record(
      'T15pre',
      '授予 host 权限（optional 权限需要用户动作触发）',
      grant === true ? 'PASS' : 'FAIL',
      `granted=${JSON.stringify(grant)}`
    );


    // 这是骨架里第一次真正调用 chrome.scripting.executeScript。
    // 之前 scripting 权限声明着但从未被使用——权限清单查不出这种"声明了没代码用"，
    // 只能靠一条真实用例把它压出来。
    await options.call(
      `chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'reader', enabled: true })`
    );

    // 站 A 的页面是登录表单，不是文章——先验"提不出正文时什么都不做"
    const noContent = await options.call(
      `chrome.runtime.sendMessage({ type: 'reader.toggle', tabId: ${knTabB.id}, action: 'install' })`
    );
    const bStillNormal = await pageB.call(
      `({ readerClass: document.body.classList.contains('keynest-reader'),
          hasContainer: !!document.getElementById('keynest-reader-content') })`
    );
    record(
      'T15a',
      '非文章页：提不出正文时返回 NO_CONTENT 且页面完全未改',
      noContent && noContent.ok === false && noContent.error === 'NO_CONTENT' &&
        bStillNormal && bStillNormal.readerClass === false && bStillNormal.hasContainer === false
        ? 'PASS'
        : 'FAIL',
      `res=${JSON.stringify(noContent)} dom=${JSON.stringify(bStillNormal)}`
    );

    // 造一个文章页：同源下用 data URL 不行（executeScript 需要真实页面），
    // 所以直接用站点 A 的 /article 路由
    const { targetId: tabArt } = await cdp.send('Target.createTarget', {
      url: `https://127.0.0.1:${PORT_A}/article`,
    });
    const pageArt = await attach(cdp, tabArt);
    await waitFor(async () => (await pageArt.call('document.readyState')) === 'complete', {
      label: 'article page load',
    });
    await sleep(600);

    const artTab = await popup.call(`(async () => {
      const ids = await chrome.tabs.query({});
      for (const t of ids) {
        const f = await chrome.webNavigation.getFrame({ tabId: t.id, frameId: 0 }).catch(() => null);
        if (f && f.url && f.url.endsWith('/article')) return { id: t.id, url: f.url };
      }
      return null;
    })()`);
    record(
      'T15b',
      '定位到文章页 tab',
      artTab && Number.isInteger(artTab.id) ? 'PASS' : 'FAIL',
      JSON.stringify(artTab)
    );

    let installRes = null;
    let articleState = null;
    if (artTab) {
      installRes = await options.call(
        `chrome.runtime.sendMessage({ type: 'reader.toggle', tabId: ${artTab.id}, action: 'install' })`
      );
      articleState = await pageArt.call(
        `({ readerClass: document.body.classList.contains('keynest-reader'),
            hasContainer: !!document.getElementById('keynest-reader-content'),
            hasStyle: !!document.getElementById('keynest-reader-content-style'),
            text: (document.getElementById('keynest-reader-content') || {}).textContent || '' })`
      );
    }
    record(
      'T15',
      '文章页：注入成功，body 加 class，正文容器与样式都在',
      installRes && installRes.ok &&
        articleState && articleState.readerClass && articleState.hasContainer && articleState.hasStyle
        ? 'PASS'
        : 'FAIL',
      `res=${JSON.stringify(installRes)} dom=${JSON.stringify({ ...(articleState||{}), text: (articleState&&articleState.text||'').slice(0,40) })}`
    );

    // ---------- T15c 原始 DOM 未被移动 ----------
    const originIntact = await pageArt.call(
      `(() => {
         const orig = document.getElementById('article-body');
         return { exists: !!orig, paragraphs: orig ? orig.querySelectorAll('p').length : -1 };
       })()`
    );
    record(
      'T15c',
      '原始正文节点仍在原位（克隆而非移动，所以退出必定可逆）',
      originIntact && originIntact.exists && originIntact.paragraphs >= 3 ? 'PASS' : 'FAIL',
      JSON.stringify(originIntact)
    );

    // ---------- T15d 退出后完全还原 ----------
    const before = await pageArt.call(
      `(() => { const b = document.body;
                return { children: b.children.length, cls: b.className }; })()`
    ).catch(() => null);
    let uninstallRes = null;
    let afterState = null;
    if (artTab) {
      uninstallRes = await options.call(
        `chrome.runtime.sendMessage({ type: 'reader.toggle', tabId: ${artTab.id}, action: 'uninstall' })`
      );
      afterState = await pageArt.call(
        `({ readerClass: document.body.classList.contains('keynest-reader'),
            hasContainer: !!document.getElementById('keynest-reader-content'),
            hasStyle: !!document.getElementById('keynest-reader-content-style') })`
      );
    }
    record(
      'T15d',
      '退出阅读模式：容器、样式、body class 全部清除',
      uninstallRes && uninstallRes.ok &&
        afterState && !afterState.readerClass && !afterState.hasContainer && !afterState.hasStyle
        ? 'PASS'
        : 'FAIL',
      `res=${JSON.stringify(uninstallRes)} dom=${JSON.stringify(afterState)}`
    );

    await cdp.send('Target.closeTarget', { targetId: tabArt }).catch(() => {});

    // ---------- T16 夜间模式：真实注入 ----------
    await options.call(
      `chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'dark', enabled: true })`
    );

    const { targetId: tabDark } = await cdp.send('Target.createTarget', {
      url: `https://127.0.0.1:${PORT_A}/article`,
    });
    const pageDark = await attach(cdp, tabDark);
    await waitFor(async () => (await pageDark.call('document.readyState')) === 'complete', {
      label: 'dark target load',
    });
    await sleep(600);

    const darkTab = await popup.call(`(async () => {
      const ids = await chrome.tabs.query({});
      let last = null;
      for (const t of ids) {
        const f = await chrome.webNavigation.getFrame({ tabId: t.id, frameId: 0 }).catch(() => null);
        if (f && f.url && f.url.endsWith('/article')) last = { id: t.id, url: f.url };
      }
      return last;
    })()`);

    const darkOn = darkTab
      ? await options.call(
          `chrome.runtime.sendMessage({ type: 'dark.toggle', tabId: ${darkTab.id}, action: 'install' })`
        )
      : null;
    const darkDom = await pageDark.call(
      `({ cls: document.documentElement.classList.contains('keynest-dark'),
          hasStyle: !!document.getElementById('keynest-dark-style') })`
    );
    record(
      'T16',
      '夜间模式：注入后根元素加 class 且样式存在',
      darkOn && darkOn.ok && darkDom && darkDom.cls && darkDom.hasStyle ? 'PASS' : 'FAIL',
      `res=${JSON.stringify(darkOn)} dom=${JSON.stringify(darkDom)}`
    );

    // ---------- T16b 参数被写进滤镜 ----------
    const darkCss = await pageDark.call(
      `(document.getElementById('keynest-dark-style') || {}).textContent || ''`
    );
    record(
      'T16b',
      '滤镜参数写进样式且不含 NaN/undefined',
      typeof darkCss === 'string' &&
        /brightness\(\d+%\)/.test(darkCss) &&
        !/NaN|undefined/.test(darkCss)
        ? 'PASS'
        : 'FAIL',
      `css=${String(darkCss).slice(0, 120)}`
    );

    // ---------- T16c 关闭后完全还原 ----------
    const darkOff = darkTab
      ? await options.call(
          `chrome.runtime.sendMessage({ type: 'dark.toggle', tabId: ${darkTab.id}, action: 'uninstall' })`
        )
      : null;
    const darkAfter = await pageDark.call(
      `({ cls: document.documentElement.classList.contains('keynest-dark'),
          hasStyle: !!document.getElementById('keynest-dark-style') })`
    );
    record(
      'T16c',
      '夜间模式关闭：class 与样式全部清除',
      darkOff && darkOff.ok && darkAfter && !darkAfter.cls && !darkAfter.hasStyle ? 'PASS' : 'FAIL',
      `res=${JSON.stringify(darkOff)} dom=${JSON.stringify(darkAfter)}`
    );

    await cdp.send('Target.closeTarget', { targetId: tabDark }).catch(() => {});

    // ---------- T14 popup 面板系统 ----------
    // popup.html 现在只有一个 #panels 容器，具体内容由 panel-host 渲染。
    // 这里验的是「面板真的被渲染出来」，而不是「popup.js 里有这段代码」。
    await options.call(
      `chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'adblock', enabled: true })`
    );
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'basic' })`);

    const { targetId: popupTab } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup/popup.html`,
    });
    const popupUi = await attach(cdp, popupTab);
    await waitFor(async () => (await popupUi.call('document.readyState')) === 'complete', {
      label: 'popup load',
    });

    const panels = await waitFor(
      async () =>
        popupUi.call(`(() => {
          const root = document.getElementById('panels');
          if (!root) return null;
          const ids = Array.from(root.querySelectorAll('section.panel')).map(s => s.dataset.panel);
          return { ids, count: ids.length, hasError: !!document.querySelector('.panel-error') };
        })()`).catch(() => null).then((v) => (v && v.count >= 1 ? v : null)),
      { label: 'popup panels rendered', timeoutMs: 12000 }
    );
    record(
      'T14',
      'popup 通过面板系统渲染（fill 面板存在，无渲染错误）',
      panels && panels.ids.includes('fill') && panels.hasError === false ? 'PASS' : 'FAIL',
      JSON.stringify(panels)
    );

    // 广告面板依赖 tab.url；popup 作为标签页打开时活动标签页是它自己，
    // 所以 host 解析失败、整块跳过 —— 这本身是正确行为，单独记一条。
    record(
      'T14b',
      'adblock 面板在拿不到站点域名时整块跳过（不显示不可用按钮）',
      panels && !panels.ids.includes('adblock') ? 'PASS' : 'FAIL',
      `ids=${JSON.stringify(panels && panels.ids)}`
    );

    // 复原
    await options.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'off' })`);
    await cdp.send('Target.closeTarget', { targetId: popupTab }).catch(() => {});

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
