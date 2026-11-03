// 扩展侧的 headless 验收：只启动无头 Chrome，不碰 GUI、不注入键鼠。
//
// # 为什么单独一个脚本
//
// `run.mjs` 是全链路验收：启动 GUI、用 SendInput 抢焦点输入主密码解锁、
// 注册 Native Messaging Host。那条路径会**打扰正在使用电脑的人**——
// 窗口跳出来、键盘输入被接管。
//
// 而扩展侧有一批能力完全不需要桌面程序参与：
//   - 内容脚本在页面里跑起来了吗
//   - 自动应用在 `load` 后是否触发
//   - SPA 换路由是否重新触发
//   - 广告规则是否装进浏览器
//   - 模块开关、配置读写是否走通
//
// 这些正好是 `CONTINUATION.md` 里挂了两轮的「未验证」项。
// 无头模式跑它们，既不打扰用户，又能把真实浏览器行为验掉。
//
// # 它测不了什么
//
// 需要 GUI 的路径（解锁 → 桥接 → 填充）它一概不碰。
// 那部分仍然必须用 `run.mjs`，且需要在机器空闲时跑。
//
// ```bash
// node test/acceptance/extension-headless.mjs
// ```

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp, browserWsUrl } from './lib/cdp.mjs';
import { CHROME, EXT_DIR, makeRoots, resetRoots } from './lib/env.mjs';

const NL = '\n';
const CDP_PORT = 9345;
const PORT = 9480;

const results = [];
function record(id, what, status, detail) {
  results.push({ id, what, status, detail });
  const mark = status === 'PASS' ? 'PASS' : 'FAIL';
  process.stdout.write(`  ${id.padEnd(7)}${mark}  ${what}${detail ? ` — ${detail}` : ''}${NL}`);
  return status === 'PASS';
}

/**
 * 造一份「已预授权 host 权限」的扩展副本。
 *
 * # 为什么需要
 *
 * `chrome.permissions.request` **要求用户手势**，而无头模式提供不了手势：
 * 调它要么被拒，要么弹一个永远没人点的确认框。
 * 于是「用户已经授权过这个站点」这条路径在无头里根本走不到，
 * 而它恰恰是最该验的一条（自动应用全靠它）。
 *
 * 办法：把 manifest 里的 `optional_host_permissions` 换成 `host_permissions`，
 * 效果等价于「用户当初点了允许」。**只有 manifest 被改，其余代码逐字节相同**，
 * 所以验的仍然是生产逻辑。
 *
 * 副作用：扩展 ID 会变（ID 由路径决定）。所有引用扩展 ID 的地方都用
 * 这次 load 返回的 ID，不写死。
 */
function makePregrantedExtension(destRoot) {
  const src = EXT_DIR;
  const dst = path.join(destRoot, 'ext');
  fs.cpSync(src, dst, { recursive: true });

  const mfPath = path.join(dst, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const origins = mf.optional_host_permissions || [];
  mf.host_permissions = origins;
  delete mf.optional_host_permissions;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');
  return dst;
}

async function main() {
  process.stdout.write(`=== 扩展侧 headless 验收（不启动 GUI）===${NL}${NL}`);

  const dirs = makeRoots('kn-headless');
  resetRoots(dirs);
  for (const p of [dirs.data, dirs.profile, dirs.logs]) {
    fs.mkdirSync(p, { recursive: true });
  }
  const extDir = makePregrantedExtension(dirs.profile);

  // 用现成的验收站点：它已经处理了自签名证书、/article 路由与双 origin。
  const { ensureCert } = await import('./lib/env.mjs');
  const { startSites } = await import('./lib/site.mjs');
  ensureCert(dirs);
  const sites = await startSites({ certDir: dirs.site, portA: PORT, portB: PORT + 1 });

  let cdp = null;
  let chrome = null;
  try {
    chrome = spawn(
      CHROME,
      [
        `--user-data-dir=${dirs.profile}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--ignore-certificate-errors',
        '--allow-insecure-localhost',
        'about:blank',
      ],
      { stdio: 'ignore', detached: true }
    );
    chrome.unref();

    cdp = await Cdp.connect(await browserWsUrl(CDP_PORT), { timeoutMs: 25000 });
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: extDir });
    const extensionId = loaded.id;
    process.stdout.write(`扩展       ${extensionId}${NL}${NL}`);

    // ---------- T1 内容脚本是否注入 ----------
    // ---------- T1 内容脚本是否注入 ----------
    const target = await createTab(cdp, `https://127.0.0.1:${PORT}/article`);
    const page = await attach(cdp, target);
    await waitReady(page);

    // 内容脚本跑在**隔离世界**里：主 world 读不到它的变量。
    // 先等那个世界出现，再切进去取标记。
    const isoCtx = await awaitIsolatedWorld(cdp, page.sessionId);
    const iso = isoCtx === null ? null : await attach(cdp, target, isoCtx);
    const hasMarker = iso ? await iso.call('window.__keynestContentLoaded === true') : false;
    record(
      'T1',
      '内容脚本在真实页面里执行（隔离世界）',
      hasMarker ? 'PASS' : 'FAIL',
      `isoCtx=${isoCtx} marker=${hasMarker}`
    );

    // ---------- T2 自动应用在 load 后触发 ----------
    // 开启夜间模式并把本站加进名单，然后重新加载页面看是否自动套上
    const opt = await openExtensionPage(cdp, extensionId, 'options/options.html');
    await opt.call(`chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'dark', enabled: true })`);

    // 预授权副本里 host 权限是常驻的，所以这里应当已经是 granted。
    // 这条顺带验证「自动应用所依赖的权限前提确实存在」。
    const permState = await opt.call(
      `chrome.permissions.contains({ origins: ['https://*/*'] }).then(v => v)`
    );
    record(
      'T2pre',
      '站点 host 权限已授予（自动应用的前提）',
      permState === true ? 'PASS' : 'FAIL',
      `contains=${permState}`
    );

    const tabId = await findTabId(opt, `https://127.0.0.1:${PORT}/article`);
    record('T2a', '定位到目标标签页', Number.isInteger(tabId) ? 'PASS' : 'FAIL', `tabId=${tabId}`);

    // 手动开一次，让名单记住这个站点
    const on = await opt.call(
      `chrome.runtime.sendMessage({ type: 'dark.toggle', tabId: ${tabId}, action: 'install', host: '127.0.0.1' })`
    );
    record('T2b', '手动开启夜间模式并写入站点名单', on && on.ok ? 'PASS' : 'FAIL', JSON.stringify(on));

    // 重新加载：自动应用应当在 load 后把样式加回去
    await page.call('location.reload()');
    await sleep(2200);
    const autoApplied = await page.call(
      `({ cls: document.documentElement.classList.contains('keynest-dark'),
          style: !!document.getElementById('keynest-dark-style') })`
    );
    record(
      'T2',
      '页面加载后自动应用夜间模式（阶段 3.6 的未验证项）',
      autoApplied && autoApplied.cls && autoApplied.style ? 'PASS' : 'FAIL',
      JSON.stringify(autoApplied)
    );

    // ---------- T3 未授权时不弹框、不注入 ----------
    // 用一个没授过权的 origin：应当安静地什么都不做
    const other = await createTab(cdp, `https://localhost:${PORT + 1}/`);
    const otherPage = await attach(cdp, other);
    await waitReady(otherPage);
    await sleep(800);
    const otherState = await otherPage.call(
      `({ cls: document.documentElement.classList.contains('keynest-dark') })`
    );
    record(
      'T3',
      '非名单站点不被注入（自动应用只对已记忆站点生效）',
      otherState && otherState.cls === false ? 'PASS' : 'FAIL',
      JSON.stringify(otherState)
    );

    // ---------- T4 广告规则真的装进浏览器 ----------
    await opt.call(`chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'adblock', enabled: true })`);
    const applied = await opt.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'basic' })`);
    const dyn = await opt.call(`chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)`);
    record(
      'T4',
      '广告规则装入浏览器（真实 declarativeNetRequest）',
      applied && applied.ok && dyn > 0 ? 'PASS' : 'FAIL',
      `res=${JSON.stringify(applied)} rules=${dyn}`
    );
    await opt.call(`chrome.runtime.sendMessage({ type: 'adblock.apply', mode: 'off' })`);

    // ---------- T5 模块开关与配置持久化 ----------
    await opt.call(`chrome.runtime.sendMessage({ type: 'dark.toggle', tabId: ${tabId}, action: 'uninstall', forget: true })`);
    const sites2 = await opt.call(`chrome.runtime.sendMessage({ type: 'dark.sites' })`);
    record(
      'T5',
      'forget 语义：站点从名单移除（真实 storage）',
      sites2 && sites2.ok && !sites2.list.includes('127.0.0.1') ? 'PASS' : 'FAIL',
      JSON.stringify(sites2 && sites2.list)
    );

    // ---------- T6 阅读模式在真实文章页提取正文 ----------
    await opt.call(`chrome.runtime.sendMessage({ type: 'modules.set-enabled', id: 'reader', enabled: true })`);
    const rd = await opt.call(
      `chrome.runtime.sendMessage({ type: 'reader.toggle', tabId: ${tabId}, action: 'install' })`
    );
    const rdDom = await page.call(
      `({ cls: document.body.classList.contains('keynest-reader'),
          has: !!document.getElementById('keynest-reader-content') })`
    );
    record(
      'T6',
      '阅读模式在真实文章页注入成功',
      rd && rd.ok && rdDom && rdDom.cls && rdDom.has ? 'PASS' : 'FAIL',
      `res=${JSON.stringify(rd)} dom=${JSON.stringify(rdDom)}`
    );
    await opt.call(`chrome.runtime.sendMessage({ type: 'reader.toggle', tabId: ${tabId}, action: 'uninstall' })`);

    // ---------- T7 SPA 换路由后要重新应用（阶段 3.6 的另一个未验证项）----------
    // SPA 换页不重新加载文档，只靠 load 事件的方案在这里会失效。
    //
    // 先把站点重新加进名单：T5 的 forget 测试刚把它移除，
    // 而自动应用的前提就是"这个站点在名单里"。
    await opt.call(
      `chrome.runtime.sendMessage({ type: 'dark.toggle', tabId: ${tabId}, action: 'install', host: '127.0.0.1' })`
    );
    //
    // 步骤：
    //   1. 打开 /spa（页面 2.5 秒后自己 pushState）
    //   2. 等自动应用生效
    //   3. **手动把样式抹掉**（模拟站点脚本覆盖了我们注入的滤镜）
    //   4. 触发一次 pushState
    //   5. 检查样式是否被重新加回来
    const spaTarget = await createTab(cdp, `https://127.0.0.1:${PORT}/spa`);
    const spaPage = await attach(cdp, spaTarget);
    await waitReady(spaPage);
    await sleep(3500);  // 等页面的 pushState 发生（2.5s）之后再看

    const spaUrl = await spaPage.call('location.pathname');
    const spaApplied = await spaPage.call(
      `document.documentElement.classList.contains('keynest-dark')`
    );
    record(
      'T7a',
      'SPA 页面首次加载时自动应用生效',
      spaApplied === true ? 'PASS' : 'FAIL',
      `cls=${spaApplied} path=${spaUrl}`
    );

    // 抹掉样式：模拟站点自己的脚本覆盖了注入的滤镜
    await spaPage.call(`(() => {
      document.documentElement.classList.remove('keynest-dark');
      const st = document.getElementById('keynest-dark-style');
      if (st) st.remove();
      return true;
    })()`);

    // 触发一次 SPA 内部跳转
    await spaPage.call(`history.pushState({}, '', '/spa/next'); true`);
    await sleep(1200);

    const reapplied = await spaPage.call(
      `({ cls: document.documentElement.classList.contains('keynest-dark'),
          style: !!document.getElementById('keynest-dark-style') })`
    );
    record(
      'T7',
      'SPA 换路由后重新应用站点偏好（阶段 3.6 的未验证项）',
      reapplied && reapplied.cls && reapplied.style ? 'PASS' : 'FAIL',
      JSON.stringify(reapplied)
    );
  } catch (e) {
    record('ERR', '验收过程抛错', 'FAIL', String(e && e.message));
  } finally {
    try {
      if (cdp) cdp.close();
    } catch {}
    try {
      chrome && chrome.kill();
    } catch {}
    try {
      await sites.close();
    } catch {}
    await sleep(500);
    try {
      fs.rmSync(dirs.profile, { recursive: true, force: true, maxRetries: 10 });
      fs.rmSync(dirs.data, { recursive: true, force: true, maxRetries: 10 });
    } catch {}
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.length - pass;
  process.stdout.write(`${NL}=== 结果：PASS ${pass} / FAIL ${fail} / 共 ${results.length} ===${NL}`);
  if (fail > 0) process.exitCode = 1;
}

/* ---------------------------- 工具 ---------------------------- */

async function createTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  return targetId;
}

/**
 * 挂到一个标签页，可选指定执行上下文。
 *
 * 为什么需要 `contextId`：内容脚本跑在**隔离世界**里，主 world 读不到
 * `window.__keynestContentLoaded`，也没有 `chrome.runtime`。
 * 想验内容脚本的行为必须精确切进那个世界
 * （`auxData.type === 'isolated' && name === 'KeyNest'`）。
 */
async function attach(cdp, targetId, contextId = null) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    sessionId,
    async call(expression) {
      const params = { expression, awaitPromise: true, returnByValue: true };
      if (contextId !== null) params.contextId = contextId;
      const r = await cdp.send('Runtime.evaluate', params, sessionId);
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    },
  };
}

/**
 * 等内容脚本的隔离世界出现，返回它的 executionContextId。
 *
 * **必须先 `Runtime.enable`**：CDP 不会把 `executionContextCreated` 推给
 * 没有启用 Runtime 域的会话。少了这一步，监听器会一直等不到事件，
 * 表现为「内容脚本没注入」——而实际上它在，只是我们没收到通知。
 * 这个坑实测过（probe 里加了 enable 就立刻收到了 id=3 的 KeyNest 世界）。
 */
async function awaitIsolatedWorld(cdp, sessionId, timeoutMs = 15000) {
  // 顺序很关键：**先挂监听，再 Runtime.enable**。
  // `Runtime.enable` 会把当前已有的执行上下文作为事件重放一遍——
  // 如果先 enable 再挂监听，那批重放事件就直接被错过了，
  // 表现成「内容脚本没注入」，而实际上它一直在。
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);

    const off = cdp.on('Runtime.executionContextCreated', (p, sid) => {
      if (sid !== sessionId) return;
      const c = p.context;
      if (c.auxData && c.auxData.type === 'isolated' && c.name === 'KeyNest') {
        clearTimeout(timer);
        off();
        resolve(c.id);
      }
    });

    // 挂好监听之后才 enable，让 CDP 重放现有上下文
    cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
  });
}

async function waitReady(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await page.call('document.readyState');
      if (s === 'complete') return;
    } catch {}
    await sleep(150);
  }
  throw new Error('PAGE_NOT_READY');
}

async function openExtensionPage(cdp, extensionId, rel) {
  const targetId = await createTab(cdp, `chrome-extension://${extensionId}/${rel}`);
  const page = await attach(cdp, targetId);
  await waitReady(page);

  // 扩展页面加载完不等于扩展 API 就绪（SW 还在启动）。
  // 这里等 `chrome.runtime.id` 真的能读到，再往下走——
  // 否则第一条 sendMessage 会撞上 `chrome.runtime` 是 undefined。
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const ok = await page.call('typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id');
      if (ok) return page;
    } catch {
      /* 还在导航 */
    }
    await sleep(200);
  }
  throw new Error('EXTENSION_API_NOT_READY');
}

/**
 * 找出 url 以给定前缀开头的标签页 id。
 *
 * 不能用 `tabs.query({url})`：扩展只有 `activeTab`，没有 `tabs` 权限时
 * 那个过滤条件既筛不到也读不到 url。改为遍历所有 tab、
 * 用 `webNavigation.getFrame` 取主 frame 的 url（这个不受 tabs 权限限制）。
 */
async function findTabId(opt, urlPrefix) {
  const all = await opt.call(`(async () => {
    const ids = await chrome.tabs.query({});
    const out = [];
    for (const t of ids) {
      const f = await chrome.webNavigation.getFrame({ tabId: t.id, frameId: 0 }).catch(() => null);
      if (f && f.url) out.push({ id: t.id, url: f.url });
    }
    return out;
  })()`);
  const hit = (all || []).find((t) => t.url.startsWith(urlPrefix));
  return hit ? hit.id : null;
}

await main();
