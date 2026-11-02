// 阅读模式的测试。
//
// # 这个文件的重点不是"能提取正文"
//
// 而是**"提不出来时什么都不做"**。阅读模式最坏的失败是提错了正文、
// 或者退出后页面回不到原样——两种都比"没提供这个功能"糟糕。
//
// 所以失败路径占多数：提不出正文、重复安装、卸载后 DOM 完全一致。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READER_CLASS,
  READER_CONTENT_ID,
  buildReaderCss,
  installReader,
  isReaderActive,
  pickContent,
  scoreElement,
  uninstallReader,
} from '../lib/reader/core.js';
import { buildDocument } from './helpers/minidom.js';

const OPTS = { width: 680, theme: 'auto' };

/** 造一个"像文章页"的文档：导航 + 正文 + 侧栏 + 页脚。 */
function articleDoc() {
  const paras = Array.from({ length: 8 }, (_, i) => ({
    tag: 'p',
    text: `这是第 ${i + 1} 段正文，写得比较长一些，用来让文本密度打分能够识别出这是正文区域。句子里有标点，也有足够多的汉字。`,
  }));
  return buildDocument({
    body: [
      {
        tag: 'nav',
        children: Array.from({ length: 12 }, (_, i) => ({
          tag: 'a',
          text: `导航链接${i}`,
        })),
      },
      {
        tag: 'div',
        attrs: { id: 'content' },
        children: paras,
      },
      {
        tag: 'aside',
        children: Array.from({ length: 20 }, (_, i) => ({
          tag: 'a',
          text: `推荐位${i}`,
        })),
      },
      { tag: 'footer', text: '页脚版权信息' },
    ],
  });
}

/* ============================ 打分 ============================ */

test('PASS: 段落多的容器分数更高', () => {
  const doc = buildDocument({
    body: [
      { tag: 'div', attrs: { id: 'a' }, children: [{ tag: 'p', text: '短' }] },
      {
        tag: 'div',
        attrs: { id: 'b' },
        children: [
          { tag: 'p', text: '第一段，写得长一些。'.repeat(3) },
          { tag: 'p', text: '第二段，也写得长一些。'.repeat(3) },
        ],
      },
    ],
  });
  const a = doc.body.children[0];
  const b = doc.body.children[1];
  assert.ok(scoreElement(b) > scoreElement(a), `${scoreElement(b)} 应大于 ${scoreElement(a)}`);
});

test('FAIL-SAFE: 链接多的容器被扣分（导航不算正文）', () => {
  const doc = buildDocument({
    body: [
      {
        tag: 'div',
        attrs: { id: 'nav' },
        children: Array.from({ length: 30 }, (_, i) => ({ tag: 'a', text: `链接${i}很长很长` })),
      },
    ],
  });
  assert.equal(scoreElement(doc.body.children[0]), 0, '全是链接应得 0 分');
});

test('FAIL-SAFE: 噪声标签里的文字不给父容器加分', () => {
  // 这是真实缺陷的回归：nav/aside 的字符数经常比正文还多，
  // 算进 textLen 会让"包着导航的 wrapper"得高分，被误判成正文。
  const doc = buildDocument({
    body: [
      {
        tag: 'div',
        attrs: { id: 'wrapper' },
        children: [
          { tag: 'nav', text: '很多很多导航文字'.repeat(50) },
          { tag: 'p', text: '短正文' },
        ],
      },
    ],
  });
  const wrapper = doc.body.children[0];
  const navOnly = doc.body.children[0].children[0];
  assert.ok(
    scoreElement(wrapper) < scoreElement(navOnly) + 1,
    'wrapper 不该因为 nav 的长文字而得高分'
  );
});

test('FAIL-SAFE: svg 标签大小写必须与 tagName 一致（大写）', () => {
  // tagName 在 HTML 里永远是大写。写成小写 'svg' 的判断永远为假，
  // 于是 SVG 里的文本（比如图标标题）会被当成正文加分。
  const doc = buildDocument({
    body: [
      {
        tag: 'div',
        children: [
          { tag: 'svg', text: '图标标题文字'.repeat(20) },
          { tag: 'p', text: '真正文' },
        ],
      },
    ],
  });
  const div = doc.body.children[0];
  // 如果 svg 被错误算入，分数会明显偏高
  const scoreWithSvg = scoreElement(div);
  assert.ok(scoreWithSvg < Math.sqrt(500) * 2, `分数 ${scoreWithSvg} 说明 svg 文本被算进去了`);
});

/* ============================ 正文提取 ============================ */

test('PASS: 语义标签（article）优先', () => {
  const doc = buildDocument({
    body: [
      { tag: 'article', attrs: { id: 'art' }, text: '正文内容'.repeat(100) },
      { tag: 'div', children: [{ tag: 'p', text: '别的'.repeat(200) }, { tag: 'p', text: 'x' }] },
    ],
  });
  const picked = pickContent(doc);
  assert.ok(picked);
  assert.equal(picked.reason, 'semantic:article');
  assert.equal(picked.element.id, 'art');
});

test('FAIL-SAFE: 语义标签内容太少时不用它', () => {
  // 有些站点的 <article> 只包一个标题，正文在别处。
  // 盲目采信会让阅读模式显示一页空白。
  const doc = buildDocument({
    body: [{ tag: 'article', text: '只有标题' }],
  });
  const picked = pickContent(doc);
  assert.equal(picked, null, '内容太少不该被采信');
});

test('PASS: 没有语义标签时按文本密度挑', () => {
  const doc = articleDoc();
  const picked = pickContent(doc);
  assert.ok(picked);
  assert.equal(picked.element.id, 'content');
  assert.match(picked.reason, /^scored:/);
});

test('FAIL-SAFE: 页面没有足够段落时返回 null', () => {
  const doc = buildDocument({
    body: [{ tag: 'div', children: [{ tag: 'span', text: '一点点文字' }] }],
  });
  assert.equal(pickContent(doc), null);
});

test('FAIL-SAFE: 空文档返回 null 而不是抛错', () => {
  assert.equal(pickContent(null), null);
  assert.equal(pickContent({}), null);
});

test('FAIL-SAFE: 段落不足 2 个的容器不参与打分', () => {
  // 单段落容器多数是行内的包装 div，采信它会把正文截成一句话
  const doc = buildDocument({
    body: [
      { tag: 'div', attrs: { id: 'one' }, children: [{ tag: 'p', text: '很长'.repeat(500) }] },
    ],
  });
  assert.equal(pickContent(doc), null);
});

/* ============================ 安装 / 卸载 ============================ */

test('PASS: 安装后进入阅读模式，正文被克隆进独立容器', () => {
  const doc = articleDoc();
  const res = installReader(doc, OPTS);
  assert.equal(res.ok, true);
  assert.equal(isReaderActive(doc), true);

  const container = doc.getElementById(READER_CONTENT_ID);
  assert.ok(container, '正文容器不存在');
  assert.ok(container.textContent.includes('第 1 段正文'));
});

test('FAIL-SAFE: 原始 DOM 一个节点都不移动（克隆而非移动）', () => {
  const doc = articleDoc();
  const original = doc.getElementById('content');
  const originalChildren = original.children.length;
  const bodyChildren = doc.body.children.length;

  installReader(doc, OPTS);

  // 原容器还在原位，子节点数量不变
  assert.equal(doc.getElementById('content'), original);
  assert.equal(original.children.length, originalChildren);
  // body 只多了一个容器（style 在 head）
  assert.equal(doc.body.children.length, bodyChildren + 1);
});

test('FAIL-SAFE: 提不出正文时什么都不做', () => {
  const doc = buildDocument({ body: [{ tag: 'div', text: '空' }] });
  const before = doc.body.children.length;
  const res = installReader(doc, OPTS);

  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_CONTENT');
  assert.equal(isReaderActive(doc), false);
  assert.equal(doc.body.children.length, before, '不该留下任何痕迹');
  assert.equal(doc.getElementById(READER_CONTENT_ID), null);
});

test('PASS: 重复安装是无操作（不是错误）', () => {
  const doc = articleDoc();
  const first = installReader(doc, OPTS);
  const second = installReader(doc, OPTS);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'already');
  // 只有一个容器
  assert.equal(doc.querySelectorAll('div').filter((d) => d.id === READER_CONTENT_ID).length, 1);
});

test('PASS: 卸载后 DOM 恢复到与安装前完全一致', () => {
  const doc = articleDoc();
  // 序列化整个 documentElement（含 head），否则装在 head 里的 <style> 看不见
  const snapshot = serialize(doc.documentElement);

  installReader(doc, OPTS);
  assert.notEqual(serialize(doc.documentElement), snapshot, '安装后应该不同');

  const res = uninstallReader(doc);
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  assert.equal(serialize(doc.documentElement), snapshot, '卸载后必须完全还原');
});

test('FAIL-SAFE: 反复安装卸载不留残留', () => {
  const doc = articleDoc();
  const snapshot = serialize(doc.documentElement);
  for (let i = 0; i < 5; i += 1) {
    installReader(doc, OPTS);
    uninstallReader(doc);
  }
  assert.equal(serialize(doc.documentElement), snapshot);
  assert.equal(doc.getElementById(`${READER_CONTENT_ID}-style`), null, 'style 残留');
});

test('PASS: 未安装时卸载是无操作', () => {
  const doc = articleDoc();
  const res = uninstallReader(doc);
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
});

/* ============================ 样式 ============================ */

test('FAIL-SAFE: 所有选择器都以阅读模式 class 或内容 id 开头（不误伤别的元素）', () => {
  const css = buildReaderCss(OPTS);
  // 逐条规则检查选择器前缀
  const selectors = css
    .split('}')
    .map((block) => block.split('{')[0].trim())
    .filter((s) => s && !s.startsWith('@') && !s.startsWith('/*'));

  for (const sel of selectors) {
    const parts = sel.split(',').map((x) => x.trim());
    for (const p of parts) {
      const ok =
        p.startsWith(`.${READER_CLASS}`) ||
        p.startsWith(`#${READER_CONTENT_ID}`) ||
        p.startsWith('@media');
      assert.ok(ok, `选择器 "${p}" 可能误伤页面其它元素`);
    }
  }
});

test('PASS: 宽度写进样式', () => {
  const css = buildReaderCss({ width: 520, theme: 'auto' });
  assert.ok(css.includes('--knr-width: 520px'));
});

test('PASS: dark 主题写入配色变量', () => {
  const css = buildReaderCss({ width: 680, theme: 'dark' });
  assert.ok(css.includes('--knr-bg:#16181c'));
  const light = buildReaderCss({ width: 680, theme: 'light' });
  assert.ok(light.includes('--knr-bg:#fbfbf9'));
});

test('FAIL-SAFE: auto 主题不写死配色（交给 prefers-color-scheme）', () => {
  const css = buildReaderCss({ width: 680, theme: 'auto' });
  assert.equal(css.includes('--knr-bg:'), false, 'auto 不该写死背景色');
  assert.ok(css.includes('prefers-color-scheme: dark'));
});

test('FAIL-SAFE: 非法宽度不让样式崩掉', () => {
  // 配置值可能从存储里读出脏数据；样式拼错的表现是整页错乱
  for (const w of [0, -100, NaN, null, undefined]) {
    const css = buildReaderCss({ width: w, theme: 'auto' });
    assert.ok(css.includes('--knr-width:'), `宽度 ${w} 时样式缺变量`);
    assert.equal(/--knr-width:\s*NaN/.test(css), false, 'NaN 进了样式');
  }
});

/* ============================ 序列化（测试工具） ============================ */

/** 把文档序列化成可比较的字符串，用于断言"完全还原"。 */
function serialize(node, depth = 0) {
  const pad = ' '.repeat(depth);
  if (!node.tagName) {
    return `${pad}#text:${node.textContent}`;
  }
  const attrs = [...node.attributes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const cls = node.classList && node.classList.value ? `class=${node.classList.value}` : '';
  const head = `${pad}<${node.tagName} ${attrs} ${cls}>`;
  const kids = (node.childNodes || []).map((c) => serialize(c, depth + 2)).join('\n');
  return `${head}\n${kids}`;
}
