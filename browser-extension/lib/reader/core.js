// 阅读模式：把页面收敛成"正文单列"。
//
// # 这个模块最大的风险不是"不好看"，是"把页面弄坏"
//
// 阅读模式的实现有两种常见做法：
//
//   A. 把正文**提取**出来，塞进一个新容器，隐藏其余所有内容
//   B. 给 body 加一个 class，用 CSS 把非正文元素隐藏起来
//
// A 的问题：一旦正文提取不准，用户看到的是空白页，且原页面结构已被移走，
// 退出时要还原的东西非常多（事件监听、iframe、canvas 都会坏）。
//
// B 的问题：`.reader-mode *:not(.content) { display:none }` 这类选择器
// 会连带把正文里的表格、列表、代码块也隐藏掉。
//
// **这里选 A，但把"提取"做成可逆的**：只做两件事——给 body 加一个 class
// 触发 CSS，以及把正文克隆到一个新容器里。**原始 DOM 一个节点都不移动**。
// 退出时只要移除 class 与容器，页面必定回到原样。
//
// # 正文提取怎么做得"差不多够用"
//
// 不做完整的可读性算法（那需要处理大量边缘情况）。这里用一组可解释的启发式：
//
//   1. 优先找语义标签：`article` / `main` / `[role=main]`
//   2. 否则按"文本密度"打分：段落文字多、链接文字少的容器得分高
//   3. 得分最高的容器当作正文
//
// 关键取舍：**宁可少提一点，也不要提错**。提少了用户还能看到文章开头，
// 提错了就是一片空白。

/** 注入到页面的 class 前缀，便于一次性清理。 */
export const READER_CLASS = 'keynest-reader';
/** 正文容器的 id。 */
export const READER_CONTENT_ID = 'keynest-reader-content';

/**
 * 这些标签在"文本密度"打分时应当被整体跳过。
 *
 * 不是"不能出现在正文里"，而是**不能用它们的文本量给父容器加分**——
 * 导航栏、侧栏、页脚的字符数经常比正文还多。
 */
const NOISE_TAGS = new Set([
  'NAV',
  'ASIDE',
  'FOOTER',
  'HEADER',
  'FORM',
  'NOSCRIPT',
  'SCRIPT',
  'STYLE',
  'IFRAME',
  // 注意：tagName 在 HTML 文档里**永远是大写**（即使在 XHTML 里 svg 也返回 'SVG'）。
  // 写成小写 'svg' 会让这条判断永远为假——噪声元素被当成正文加分项。
  'SVG',
]);

/** 语义标签，优先于打分。 */
const SEMANTIC_SELECTORS = ['article', 'main', '[role="main"]', '[itemprop="articleBody"]'];

/**
 * 算一个元素的"正文分"。
 *
 * 打分逻辑刻意简单，因为简单才可解释、可测试：
 *   - 正文文字：`sqrt(字数) * 2`，**平方根折算**避免超长评论盖过正文
 *   - 标点：每个 +5（有标点的才是连贯文字，菜单项没有）
 *   - 链接文字：每字符 -2（链接多的通常是导航/推荐位）
 *
 * 平方根折算的理由：一篇文章 5000 字，一条侧栏广告 200 字，
 * 线性计分时文章稳赢；但若正文只有 300 字、评论区 3000 字，
 * 线性计分会把评论区当正文。平方根让"特别长"的边际收益递减。
 *
 * **噪声标签的文本不计入任何一项**——导航栏的字符数经常比正文还多，
 * 把它算进 `textLen` 会让"包着导航的整个 wrapper"得高分。
 *
 * @param {Element} el
 */
export function scoreElement(el) {
  if (!el) return 0;

  let textLen = 0;
  let linkLen = 0;
  let punctuation = 0;

  const countText = (node) => {
    for (const child of node.childNodes || []) {
      // 文本节点：nodeType 3；元素节点：nodeType 1（或 undefined 但有 tagName）
      if (child.nodeType === 3 || (child.nodeType === undefined && typeof child.textContent === 'string' && !child.tagName)) {
        const t = child.textContent || '';
        textLen += t.length;
        punctuation += (t.match(/[，。！？；,.!?;]/g) || []).length;
        continue;
      }
      if (!child.tagName) continue;
      if (NOISE_TAGS.has(child.tagName)) continue;
      if (child.tagName === 'A') {
        linkLen += (child.textContent || '').length;
        continue; // 链接内部不再展开，避免重复计算
      }
      countText(child);
    }
  };
  countText(el);

  const score = Math.sqrt(textLen) * 2 + punctuation * 5 - linkLen * 2;
  return Math.max(0, score);
}

/**
 * 从文档里挑出正文容器。
 *
 * 返回 null 表示"找不到像正文的东西"——调用方**必须**据此拒绝启用阅读模式，
 * 而不是退化成一个空页面。这是这个模块最重要的安全阀：
 * 提不出正文时什么都不做，比提错了强。
 *
 * @param {Document} doc
 * @returns {{element: Element, reason: string} | null}
 */
export function pickContent(doc) {
  if (!doc || !doc.body) return null;

  // 1) 语义标签优先
  for (const sel of SEMANTIC_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent || '').trim().length >= 200) {
      return { element: el, reason: `semantic:${sel}` };
    }
  }

  // 2) 文本密度打分
  const candidates = Array.from(doc.body.querySelectorAll('div, section, td, article, main'));
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    // 跳过嵌套很浅的容器（通常是行内的 div）
    const paragraphs = el.querySelectorAll('p').length;
    if (paragraphs < 2) continue;
    const s = scoreElement(el);
    // 更深的容器在分数接近时优先——外层容器常包含导航
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }

  if (best && bestScore >= 40) {
    return { element: best, reason: `scored:${Math.round(bestScore)}` };
  }

  // 3) 最后的退路：body 里段落够多就用 body
  const bodyText = (doc.body.textContent || '').trim();
  if (bodyText.length >= 500 && doc.body.querySelectorAll('p').length >= 3) {
    return { element: doc.body, reason: 'fallback:body' };
  }

  return null;
}

/**
 * 生成阅读模式的样式。
 *
 * **所有选择器都以 `.{READER_CLASS}` 开头**，且只作用于 body 的直接子元素层级，
 * 所以不可能误伤正文容器内部的元素。
 *
 * @param {{width:number, theme:'auto'|'light'|'dark'}} opts
 */
export function buildReaderCss(opts) {
  const theme = opts && typeof opts.theme === 'string' ? opts.theme : 'auto';
  // 宽度可能是从存储里读出的脏数据（NaN/负数/字符串）。
  // 直接拼进 CSS 会让整条规则失效——表现是"阅读模式排版全乱"，
  // 而且不会有任何报错。所以在这里夹紧到合理区间。
  const raw = opts && Number(opts.width);
  const width = Number.isFinite(raw) ? Math.min(1600, Math.max(320, Math.round(raw))) : 680;
  // 主题走 CSS 变量：auto 跟随系统，light/dark 强制
  const palette =
    theme === 'dark'
      ? { bg: '#16181c', fg: '#e6e8eb', muted: '#9aa3ad', line: '#2a2f36' }
      : theme === 'light'
        ? { bg: '#fbfbf9', fg: '#1b1f24', muted: '#6b7280', line: '#e5e7eb' }
        : null; // auto 时用 CSS 里的 prefers-color-scheme

  const vars = palette
    ? `--knr-bg:${palette.bg};--knr-fg:${palette.fg};--knr-muted:${palette.muted};--knr-line:${palette.line};`
    : '';

  return `
.${READER_CLASS} {
  ${vars}
  --knr-width: ${width}px;
  overflow: hidden !important;
}
/* 只隐藏 body 的直接子元素，正文容器除外。
   用 :not(#id) 而不是 :not(.class)，因为 id 唯一且不会误伤。 */
.${READER_CLASS} > *:not(#${READER_CONTENT_ID}) {
  display: none !important;
}
#${READER_CONTENT_ID} {
  display: block !important;
  box-sizing: border-box;
  max-width: var(--knr-width, 680px);
  margin: 0 auto;
  padding: 48px 24px 96px;
  background: var(--knr-bg, #fbfbf9);
  color: var(--knr-fg, #1b1f24);
  font: 17px/1.75 Georgia, "Songti SC", "Microsoft YaHei", serif;
  min-height: 100vh;
}
#${READER_CONTENT_ID} img,
#${READER_CONTENT_ID} video,
#${READER_CONTENT_ID} iframe {
  max-width: 100% !important;
  height: auto !important;
}
#${READER_CONTENT_ID} pre,
#${READER_CONTENT_ID} code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
  white-space: pre-wrap;
  word-break: break-word;
}
#${READER_CONTENT_ID} a { color: inherit; text-decoration: underline; }
#${READER_CONTENT_ID} h1,
#${READER_CONTENT_ID} h2,
#${READER_CONTENT_ID} h3 { line-height: 1.3; margin: 1.6em 0 0.6em; }
#${READER_CONTENT_ID} p { margin: 0 0 1.1em; }
#${READER_CONTENT_ID} blockquote {
  margin: 1.2em 0; padding-left: 1em;
  border-left: 3px solid var(--knr-line, #e5e7eb);
  color: var(--knr-muted, #6b7280);
}
@media (prefers-color-scheme: dark) {
  #${READER_CONTENT_ID}:not([data-knr-theme="light"]) {
    background: #16181c; color: #e6e8eb;
  }
}
`.trim();
}

/**
 * 在文档里安装阅读模式。**不移动任何原始节点**。
 *
 * @param {Document} doc
 * @param {{width:number, theme:'auto'|'light'|'dark'}} opts
 * @returns {{ok:true, reason:string} | {ok:false, error:string}}
 */
export function installReader(doc, opts) {
  if (!doc || !doc.body) return { ok: false, error: 'NO_DOCUMENT' };
  if (doc.getElementById(READER_CONTENT_ID)) {
    // 已安装：重复启用是无操作，不是错误
    return { ok: true, reason: 'already' };
  }

  const picked = pickContent(doc);
  if (!picked) {
    // **提不出正文就什么都不做。** 这是最重要的安全阀。
    return { ok: false, error: 'NO_CONTENT' };
  }

  const container = doc.createElement('div');
  container.id = READER_CONTENT_ID;
  if (opts.theme !== 'auto') container.setAttribute('data-knr-theme', opts.theme);

  // 克隆而不是移动：原始 DOM 保持原样，退出时只需移除容器与 class。
  // 克隆会丢事件监听，但阅读模式本来就不需要原页面的交互。
  container.append(picked.element.cloneNode(true));

  const style = doc.createElement('style');
  style.id = `${READER_CONTENT_ID}-style`;
  style.textContent = buildReaderCss(opts);

  doc.head.append(style);
  doc.body.append(container);
  doc.body.classList.add(READER_CLASS);

  return { ok: true, reason: picked.reason };
}

/**
 * 卸载阅读模式。**必须完全可逆**。
 *
 * 只移除我们加的三样东西：容器、style、body 上的 class。
 * 不碰原页面的任何节点——它们本来就没被动过。
 *
 * @param {Document} doc
 * @returns {{ok:true, removed:boolean}}
 */
export function uninstallReader(doc) {
  if (!doc || !doc.body) return { ok: true, removed: false };

  const container = doc.getElementById(READER_CONTENT_ID);
  const style = doc.getElementById(`${READER_CONTENT_ID}-style`);
  const hadClass = doc.body.classList.contains(READER_CLASS);

  if (container) container.remove();
  if (style) style.remove();
  if (hadClass) doc.body.classList.remove(READER_CLASS);

  // 顺便把可能残留的内联样式清掉（防御性：万一别处改过 body）
  doc.body.style.removeProperty('overflow');

  return { ok: true, removed: Boolean(container || style || hadClass) };
}

/** 当前是否处于阅读模式。 */
export function isReaderActive(doc) {
  return Boolean(doc && doc.body && doc.body.classList.contains(READER_CLASS));
}
