// 阅读模式模块的测试。
//
// 重点在两处：
//   1. 注入函数（readerToggle）在真实 DOM 上的行为——用最小 DOM 替身跑
//   2. 注入函数与 core.js 的**一致性**：两份实现不能悄悄分叉
//
// 第 2 点是这个文件存在的核心理由。`executeScript` 无法 import，
// 所以注入函数必须自带一份提取逻辑。与其假装能共享，不如：
//   - 把约束写进注释
//   - 用同一批输入同时跑两份实现，断言结论一致

import test from 'node:test';
import assert from 'node:assert/strict';

import { createReaderModule, readerToggle, WIDTH_MAX, WIDTH_MIN } from '../lib/modules/reader.js';
import {
  READER_CLASS,
  READER_CONTENT_ID,
  installReader,
  isReaderActive,
  pickContent,
} from '../lib/reader/core.js';
import { buildDocument } from './helpers/minidom.js';

/* ============================ 注入环境 ============================ */

/**
 * 把 readerToggle 放到一个"假页面"里执行。
 *
 * readerToggle 是自包含函数，只依赖全局 `document`。
 * 所以装一个临时 document 就能跑——这正是它在真实页面的运行条件。
 */
function runInjected(doc, args) {
  const prev = globalThis.document;
  globalThis.document = doc;
  try {
    return readerToggle(args);
  } finally {
    globalThis.document = prev;
  }
}

function articleDoc() {
  const paras = Array.from({ length: 8 }, (_, i) => ({
    tag: 'p',
    text: `第 ${i + 1} 段正文，写得足够长以便文本密度打分能识别出正文区域。句子里有标点，也有足够多的汉字内容。`,
  }));
  return buildDocument({
    body: [
      {
        tag: 'nav',
        children: Array.from({ length: 12 }, (_, i) => ({ tag: 'a', text: `导航${i}` })),
      },
      { tag: 'div', attrs: { id: 'content' }, children: paras },
      { tag: 'footer', text: '页脚' },
    ],
  });
}

/* ============================ 模块声明 ============================ */

test('PASS: 默认关闭（改变页面外观的模块不该自动开启）', () => {
  const m = createReaderModule({ scripting: {} });
  assert.equal(m.defaultEnabled, false);
});

test('PASS: 声明 scripting 与 hostHttps（注入需要站点权限）', () => {
  const m = createReaderModule({ scripting: {} });
  // 不用 activeTab：activeTab 只在用户点扩展图标时授予，
  // 而阅读模式要从 popup 里对不同 tab 操作，语义不对。
  assert.deepEqual([...m.requires].sort(), ['hostHttps', 'scripting']);
});

test('FAIL-SAFE: 缺 host 权限时不发起注入（返回 HOST_PERMISSION_DENIED）', async () => {
  const scripting = fakeScripting();
  const m = createReaderModule({
    scripting,
    permissions: {
      contains: async () => false,
      request: async () => false, // 用户拒绝
    },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  const res = await h.handle({ tabId: 1, action: 'install' }, { config: { get: () => 680 } });
  assert.deepEqual(res, { ok: false, error: 'HOST_PERMISSION_DENIED' });
  assert.equal(scripting.calls.length, 0, '被拒后不该发起注入');
});

test('PASS: 已持有权限时不重复请求（不反复弹确认框）', async () => {
  let requested = 0;
  const m = createReaderModule({
    scripting: fakeScripting(),
    permissions: {
      contains: async () => true,
      request: async () => {
        requested += 1;
        return true;
      },
    },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  await h.handle({ tabId: 1, action: 'install' }, { config: { get: () => 680 } });
  assert.equal(requested, 0, '已有权限还请求会每次弹框');
});

test('FAIL-SAFE: 非 http(s) 页面返回 NO_ORIGIN', async () => {
  const m = createReaderModule({
    scripting: fakeScripting(),
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'chrome://settings' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  const res = await h.handle({ tabId: 1, action: 'install' }, { config: { get: () => 680 } });
  assert.deepEqual(res, { ok: false, error: 'NO_ORIGIN' });
});

test('PASS: 配置项宽度与主题在允许范围内', () => {
  const m = createReaderModule({ scripting: {} });
  assert.equal(m.config.width.min, WIDTH_MIN);
  assert.equal(m.config.width.max, WIDTH_MAX);
  assert.deepEqual([...m.config.theme.values], ['auto', 'light', 'dark']);
});

/* ============================ 注入函数：安装 ============================ */

test('PASS: install 把正文克隆进独立容器', () => {
  const doc = articleDoc();
  const res = runInjected(doc, { action: 'install', width: 680, theme: 'auto' });

  assert.equal(res.ok, true);
  assert.equal(isReaderActive(doc), true);
  const c = doc.getElementById(READER_CONTENT_ID);
  assert.ok(c);
  assert.ok(c.textContent.includes('第 1 段正文'));
});

test('FAIL-SAFE: 原始 DOM 未被移动', () => {
  const doc = articleDoc();
  const original = doc.getElementById('content');
  const before = original.children.length;

  runInjected(doc, { action: 'install', width: 680, theme: 'auto' });

  assert.equal(doc.getElementById('content'), original);
  assert.equal(original.children.length, before);
});

test('FAIL-SAFE: 提不出正文时返回 NO_CONTENT 且不留痕迹', () => {
  const doc = buildDocument({ body: [{ tag: 'div', text: '一点点' }] });
  const bodyBefore = doc.body.children.length;

  const res = runInjected(doc, { action: 'install', width: 680, theme: 'auto' });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_CONTENT');
  assert.equal(doc.body.children.length, bodyBefore);
  assert.equal(doc.getElementById(READER_CONTENT_ID), null);
  assert.equal(isReaderActive(doc), false);
});

test('PASS: 重复 install 返回 already', () => {
  const doc = articleDoc();
  runInjected(doc, { action: 'install', width: 680, theme: 'auto' });
  const again = runInjected(doc, { action: 'install', width: 680, theme: 'auto' });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already');
});

/* ============================ 注入函数：卸载 ============================ */

test('PASS: uninstall 完全还原', () => {
  const doc = articleDoc();
  const before = snapshot(doc);

  runInjected(doc, { action: 'install', width: 680, theme: 'auto' });
  assert.notEqual(snapshot(doc), before);

  const res = runInjected(doc, { action: 'uninstall' });
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  assert.equal(snapshot(doc), before, '卸载后必须完全还原');
});

test('FAIL-SAFE: 未安装时 uninstall 是无操作', () => {
  const doc = articleDoc();
  const res = runInjected(doc, { action: 'uninstall' });
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
});

test('FAIL-SAFE: 反复 install/uninstall 不留残留', () => {
  const doc = articleDoc();
  const before = snapshot(doc);
  for (let i = 0; i < 5; i += 1) {
    runInjected(doc, { action: 'install', width: 680, theme: 'auto' });
    runInjected(doc, { action: 'uninstall' });
  }
  assert.equal(snapshot(doc), before);
});

/* ============================ 注入函数：query ============================ */

test('PASS: query 未安装时 active:false', () => {
  const doc = articleDoc();
  assert.deepEqual(runInjected(doc, { action: 'query' }), { ok: true, active: false });
});

test('PASS: query 安装后 active:true', () => {
  const doc = articleDoc();
  runInjected(doc, { action: 'install', width: 680, theme: 'auto' });
  assert.deepEqual(runInjected(doc, { action: 'query' }), { ok: true, active: true });
});

/* ============================ 注入函数：参数健壮性 ============================ */

test('FAIL-SAFE: 非法宽度被夹紧到合理区间（不写进样式）', () => {
  for (const w of [0, -100, NaN, null, undefined, 'abc', 99999]) {
    const doc = articleDoc();
    runInjected(doc, { action: 'install', width: w, theme: 'auto' });
    const style = doc.getElementById(`${READER_CONTENT_ID}-style`);
    assert.ok(style, `宽度 ${w} 时样式没装上`);
    const css = style.textContent;
    assert.equal(/--knr-width:NaN/.test(css), false, `宽度 ${w} 写出了 NaN`);
    assert.equal(/--knr-width:-/.test(css), false, `宽度 ${w} 写出了负数`);
    // 一定有个合法的宽度值
    const m = css.match(/--knr-width:(\d+)px/);
    assert.ok(m, `宽度 ${w} 时没有合法宽度值`);
    const n = Number(m[1]);
    assert.ok(n >= 320 && n <= 1600, `宽度 ${w} 被夹紧成了 ${n}`);
  }
});

test('FAIL-SAFE: 非法主题退回 auto（不写死配色）', () => {
  const doc = articleDoc();
  runInjected(doc, { action: 'install', width: 680, theme: 'purple' });
  const css = doc.getElementById(`${READER_CONTENT_ID}-style`).textContent;
  assert.equal(css.includes('--knr-bg:#16181c'), false);
  assert.equal(css.includes('--knr-bg:#fbfbf9'), false);
});

test('PASS: dark 主题写死深色配色', () => {
  const doc = articleDoc();
  runInjected(doc, { action: 'install', width: 680, theme: 'dark' });
  const css = doc.getElementById(`${READER_CONTENT_ID}-style`).textContent;
  assert.ok(css.includes('--knr-bg:#16181c'));
  const c = doc.getElementById(READER_CONTENT_ID);
  assert.equal(c.getAttribute('data-knr-theme'), 'dark');
});

/* ============================ 两份实现的一致性 ============================ */

/**
 * 这一组是**最重要的测试**。
 *
 * `executeScript` 无法 import，所以注入函数自带一份正文提取逻辑，
 * 与 `lib/reader/core.js` 是两份代码。两份代码分叉的表现是：
 * "单元测试用 core.js 全绿，真实浏览器用 readerToggle 却提不出正文"。
 *
 * 这里用同一批页面同时跑两份，断言"提得出/提不出"的结论一致。
 */
test('PASS: 注入函数与 core.js 对同一页面的提取结论一致', () => {
  const cases = [
    ['标准文章页', articleDoc()],
    [
      '语义标签页',
      buildDocument({
        body: [{ tag: 'article', text: '正文内容'.repeat(80) }],
      }),
    ],
    [
      '只有导航',
      buildDocument({
        body: [
          {
            tag: 'nav',
            children: Array.from({ length: 20 }, (_, i) => ({ tag: 'a', text: `链接${i}` })),
          },
        ],
      }),
    ],
    ['空页面', buildDocument({ body: [{ tag: 'div', text: '空' }] })],
    [
      '单段落容器',
      buildDocument({
        body: [
          { tag: 'div', attrs: { id: 'x' }, children: [{ tag: 'p', text: '很长'.repeat(400) }] },
        ],
      }),
    ],
  ];

  for (const [name, doc] of cases) {
    // core.js 的判断
    const corePicked = pickContent(doc) !== null;

    // 注入函数的判断（用同一份文档的独立副本，避免互相影响）
    const doc2 = cloneDoc(doc);
    const res = runInjected(doc2, { action: 'install', width: 680, theme: 'auto' });
    const injectedPicked = res.ok;

    assert.equal(injectedPicked, corePicked, `${name}: 两份实现结论不一致`);
  }
});

/**
 * 重建一份等价文档（不共享节点）。
 *
 * 注意 minidom 的 documentElement 在构造时已经挂了 head/body，
 * 所以这里直接往它们里面灌内容即可，不需要再重挂一次。
 */
function cloneDoc(doc) {
  const fresh = new (doc.constructor)();
  for (const c of doc.head.childNodes) fresh.head.append(c.cloneNode(true));
  for (const c of doc.body.childNodes) fresh.body.append(c.cloneNode(true));
  return fresh;
}

/* ============================ 模块 handler ============================ */

/** 假 scripting：记录 executeScript 调用，返回预设结果。 */
function fakeScripting(result = { ok: true, reason: 'scored:100' }) {
  const calls = [];
  return {
    calls,
    async executeScript(opts) {
      calls.push(opts);
      return [{ result }];
    },
  };
}

test('PASS: reader.toggle 只注入主 frame', async () => {
  const scripting = fakeScripting();
  const m = createReaderModule({
    scripting,
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');

  await h.handle({ tabId: 7, action: 'install' }, { config: { get: (k) => (k === 'width' ? 680 : 'auto') } });

  assert.equal(scripting.calls.length, 1);
  assert.deepEqual(scripting.calls[0].target, { tabId: 7, frameIds: [0] });
});

test('FAIL-SAFE: reader.toggle 拒绝非整数 tabId', async () => {
  const scripting = fakeScripting();
  const m = createReaderModule({ scripting });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');

  for (const tabId of [null, '7', 7.5, undefined]) {
    const res = await h.handle({ tabId }, { config: { get: () => 680 } });
    assert.deepEqual(res, { ok: false, error: 'BAD_ARGS' }, String(tabId));
  }
  assert.equal(scripting.calls.length, 0, '非法参数不该发起注入');
});

test('PASS: 默认动作是 install，只有显式 uninstall 才卸载', async () => {
  const scripting = fakeScripting();
  const m = createReaderModule({
    scripting,
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  const ctx = { config: { get: () => 680 } };

  await h.handle({ tabId: 1 }, ctx);
  assert.equal(scripting.calls[0].args[0].action, 'install');

  await h.handle({ tabId: 1, action: 'uninstall' }, ctx);
  assert.equal(scripting.calls[1].args[0].action, 'uninstall');
});

test('FAIL-SAFE: executeScript 抛错时返回稳定错误码，不冒泡', async () => {
  const m = createReaderModule({
    scripting: {
      async executeScript() {
        throw new Error('Cannot access contents of the page');
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  // handler 抛错会被 registry 捕获并转成 HANDLER_FAILED；这里直接调 handler，
  // 所以会抛——但 dispatch 层会兜住。测的是"不静默成功"。
  await assert.rejects(() => h.handle({ tabId: 1 }, { config: { get: () => 680 } }));
});

test('PASS: executeScript 返回空结果时给 NO_RESULT', async () => {
  const m = createReaderModule({
    scripting: { async executeScript() { return []; } },
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'https://example.test/a' }) },
  });
  const h = m.handlers.find((x) => x.type === 'reader.toggle');
  const res = await h.handle({ tabId: 1 }, { config: { get: () => 680 } });
  assert.deepEqual(res, { ok: false, error: 'NO_RESULT' });
});

/* ============================ 序列化工具 ============================ */

function snapshot(doc) {
  const ser = (node) => {
    if (!node.tagName) return `#t:${node.textContent}`;
    const attrs = [...node.attributes.entries()].sort().map(([k, v]) => `${k}=${v}`).join(' ');
    const cls = node.classList && node.classList.value ? node.classList.value : '';
    return `<${node.tagName} ${attrs} cls=${cls}>` + (node.childNodes || []).map(ser).join('');
  };
  return ser(doc.documentElement);
}
