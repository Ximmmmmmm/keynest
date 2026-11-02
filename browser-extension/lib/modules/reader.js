// 阅读模式模块：用 `chrome.scripting` 把阅读逻辑注入当前页面。
//
// # 这是骨架里第一次真正用到 `scripting`
//
// 之前 `scripting` 权限声明着却**从未被调用**——这正是权限清单该发现
// 却不是它能发现的"权限膨胀"（清单只比对模块声明与 manifest，
// 查不出"模块声明了但代码没用"）。阅读模式把这条链路第一次压了出来。
//
// # 注入的是函数，不是文件
//
// `chrome.scripting.executeScript({ func })` 会把函数序列化后注入页面主世界。
// 好处是不需要额外声明 `web_accessible_resources`（那会把文件暴露给网页）。
//
// 坏处是**注入的函数不能引用外部变量**——它会被单独序列化，
// 上文的任何 import 都不存在。所以这里采用"注入一个自包含的小函数，
// 它自己判断要不要装/卸"，而完整的提取算法留在扩展侧。
//
// # 为什么提取算法不注入
//
// 提取算法（reader/core.js）有 200 行，全靠序列化带过去会很难调试，
// 而且 `cloneNode` 之后的内容要传回来也很浪费。
//
// 折中方案：
//   1. 注入一个**自包含**的 `readerToggle` 函数，它只做 DOM 操作
//   2. 那个函数里的提取逻辑是 core.js 的精简版，两边由测试保证行为一致
//
// 这看起来像"两份实现"，但它是 `executeScript` 的硬约束——
// 注入函数无法 import。与其假装可以共享，不如把约束写明并加一致性测试。

import { injectInto } from '../inject.js';

/** 阅读模式可用的宽度范围（与设置页一致）。 */
export const WIDTH_MIN = 480;
export const WIDTH_MAX = 1200;

/**
 * 注入到页面的函数。**必须完全自包含**：不能引用任何外部变量。
 *
 * 它接收一个 args 对象（executeScript 的 `args` 参数），返回执行结果。
 *
 * @param {{action:'install'|'uninstall'|'query', width:number, theme:string}} args
 */
function readerToggle(args) {
  const READER_CLASS = 'keynest-reader';
  const CONTENT_ID = 'keynest-reader-content';
  const STYLE_ID = 'keynest-reader-content-style';

  const isActive = () => document.body && document.body.classList.contains(READER_CLASS);

  const uninstall = () => {
    const c = document.getElementById(CONTENT_ID);
    const s = document.getElementById(STYLE_ID);
    const had = isActive();
    if (c) c.remove();
    if (s) s.remove();
    if (had) document.body.classList.remove(READER_CLASS);
    document.body.style.removeProperty('overflow');
    return { ok: true, removed: Boolean(c || s || had) };
  };

  if (args.action === 'query') {
    return { ok: true, active: isActive() };
  }
  if (args.action === 'uninstall') {
    return uninstall();
  }

  if (isActive()) return { ok: true, reason: 'already' };

  // ---- 正文提取（core.js 的精简版，行为由一致性测试保证）----
  const NOISE = new Set(['NAV', 'ASIDE', 'FOOTER', 'HEADER', 'FORM', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'IFRAME', 'SVG']);

  const score = (el) => {
    let textLen = 0;
    let linkLen = 0;
    let punct = 0;
    const walk = (node) => {
      for (const child of node.childNodes || []) {
        if (child.nodeType === 3) {
          const t = child.textContent || '';
          textLen += t.length;
          punct += (t.match(/[，。！？；,.!?;]/g) || []).length;
          continue;
        }
        if (!child.tagName) continue;
        if (NOISE.has(child.tagName)) continue;
        if (child.tagName === 'A') {
          linkLen += (child.textContent || '').length;
          continue;
        }
        walk(child);
      }
    };
    walk(el);
    return Math.max(0, Math.sqrt(textLen) * 2 + punct * 5 - linkLen * 2);
  };

  const pick = () => {
    for (const sel of ['article', 'main', '[role="main"]', '[itemprop="articleBody"]']) {
      const el = document.querySelector(sel);
      if (el && (el.textContent || '').trim().length >= 200) {
        return { el, reason: 'semantic:' + sel };
      }
    }
    const cands = Array.from(document.body.querySelectorAll('div, section, td, article, main'));
    let best = null;
    let bestScore = 0;
    for (const el of cands) {
      if (el.querySelectorAll('p').length < 2) continue;
      const s = score(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    if (best && bestScore >= 40) return { el: best, reason: 'scored:' + Math.round(bestScore) };

    const bodyText = (document.body.textContent || '').trim();
    if (bodyText.length >= 500 && document.body.querySelectorAll('p').length >= 3) {
      return { el: document.body, reason: 'fallback:body' };
    }
    return null;
  };

  const picked = pick();
  if (!picked) {
    // **提不出正文就什么都不做。**
    return { ok: false, error: 'NO_CONTENT' };
  }

  const width = Number.isFinite(Number(args.width))
    ? Math.min(1600, Math.max(320, Math.round(Number(args.width))))
    : 680;
  const theme = args.theme === 'dark' || args.theme === 'light' ? args.theme : 'auto';

  const P =
    theme === 'dark'
      ? '--knr-bg:#16181c;--knr-fg:#e6e8eb;--knr-muted:#9aa3ad;--knr-line:#2a2f36;'
      : theme === 'light'
        ? '--knr-bg:#fbfbf9;--knr-fg:#1b1f24;--knr-muted:#6b7280;--knr-line:#e5e7eb;'
        : '';

  const css =
    '.' + READER_CLASS + '{' + P + '--knr-width:' + width + 'px;overflow:hidden !important;}' +
    '.' + READER_CLASS + ' > *:not(#' + CONTENT_ID + '){display:none !important;}' +
    '#' + CONTENT_ID + '{display:block !important;box-sizing:border-box;max-width:var(--knr-width);' +
    'margin:0 auto;padding:48px 24px 96px;background:var(--knr-bg,#fbfbf9);color:var(--knr-fg,#1b1f24);' +
    'font:17px/1.75 Georgia,"Songti SC","Microsoft YaHei",serif;min-height:100vh;}' +
    '#' + CONTENT_ID + ' img,#' + CONTENT_ID + ' video,#' + CONTENT_ID + ' iframe{max-width:100% !important;height:auto !important;}' +
    '#' + CONTENT_ID + ' pre,#' + CONTENT_ID + ' code{font-family:ui-monospace,Consolas,monospace;' +
    'font-size:0.92em;white-space:pre-wrap;word-break:break-word;}' +
    '#' + CONTENT_ID + ' a{color:inherit;text-decoration:underline;}' +
    '#' + CONTENT_ID + ' h1,#' + CONTENT_ID + ' h2,#' + CONTENT_ID + ' h3{line-height:1.3;margin:1.6em 0 0.6em;}' +
    '#' + CONTENT_ID + ' p{margin:0 0 1.1em;}' +
    '#' + CONTENT_ID + ' blockquote{margin:1.2em 0;padding-left:1em;' +
    'border-left:3px solid var(--knr-line,#e5e7eb);color:var(--knr-muted,#6b7280);}' +
    '@media (prefers-color-scheme: dark){#' + CONTENT_ID + ':not([data-knr-theme="light"]){background:#16181c;color:#e6e8eb;}}';

  const container = document.createElement('div');
  container.id = CONTENT_ID;
  if (theme !== 'auto') container.setAttribute('data-knr-theme', theme);
  // 克隆而不是移动：原始 DOM 保持原样，卸载时只需移除容器与 class。
  container.appendChild(picked.el.cloneNode(true));

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;

  document.head.appendChild(style);
  document.body.appendChild(container);
  document.body.classList.add(READER_CLASS);

  return { ok: true, reason: picked.reason };
}

/**
 * 建阅读模式模块。
 *
 * @param {object} deps
 * @param {object} deps.scripting   `chrome.scripting`
 * @param {object} [deps.permissions] `chrome.permissions`（用于按站点申请注入权限）
 */
export function createReaderModule(deps) {
  const scripting = deps.scripting;

  /** 在指定 tab 的主 frame 里执行注入函数（权限申请由 inject.js 统一处理）。 */
  async function run(tabId, args, needPermission) {
    const out = await injectInto(deps, tabId, readerToggle, [args], { needPermission });
    if (!out.ok) return out;
    return out.result;
  }

  return {
    id: 'reader',
    title: '阅读模式',
    description: '把文章页收敛成正文单列，去掉导航、侧栏与浮动元素',
    // 默认关闭：这是会改变页面外观的模块，应当由用户主动开启。
    defaultEnabled: false,
    // hostHttps：注入需要站点权限（manifest 里是 optional，用前申请）
    requires: ['scripting', 'hostHttps'],
    config: {
      width: { type: 'number', default: 680, min: WIDTH_MIN, max: WIDTH_MAX, integer: true },
      theme: { type: 'enum', values: ['auto', 'light', 'dark'], default: 'auto' },
    },
    handlers: [
      {
        type: 'reader.toggle',
        handle: async (msg, ctx) => {
          const tabId = msg.tabId;
          if (!Number.isInteger(tabId)) return { ok: false, error: 'BAD_ARGS' };

          const action = msg.action === 'uninstall' ? 'uninstall' : 'install';

          // 权限申请与注入细节由 lib/inject.js 统一处理——
          // 每个注入类模块都要走"查权限 → 按需申请 → 才注入"，
          // 各写一遍只会让某个模块忘了先查、于是每次弹框。
          return run(
            tabId,
            {
              action,
              width: ctx.config.get('width'),
              theme: ctx.config.get('theme'),
            },
            // 卸载不需要权限：样式本来就是我们自己加的
            action === 'install'
          );
        },
      },
      {
        type: 'reader.query',
        handle: async (msg) => {
          const tabId = msg.tabId;
          if (!Number.isInteger(tabId)) return { ok: false, error: 'BAD_ARGS' };
          return run(tabId, { action: 'query', width: 0, theme: 'auto' }, false);
        },
      },
    ],
  };
}

export { readerToggle };
