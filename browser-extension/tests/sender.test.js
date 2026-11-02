// 消息来源分类的自动化测试（缺陷 B 的回归防线）。
//
// 核心断言：**sender.tab 存在与否不能决定身份**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySender } from '../lib/sender.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const CTX = {
  extensionId: EXT_ID,
  extensionBase: `chrome-extension://${EXT_ID}/`,
  privilegedPages: ['popup/popup.html'],
};

function sndr(over = {}) {
  return { id: EXT_ID, url: '', ...over };
}

/* --------------------------- 特权页面 --------------------------- */

test('PASS: popup（无 tab）被识别为特权页面', () => {
  const s = sndr({ url: `chrome-extension://${EXT_ID}/popup/popup.html` });
  assert.equal(classifySender(s, CTX), 'popup');
});

test('PASS: options 在标签页里打开时仍被识别为特权页面（缺陷 B 的核心）', () => {
  // open_in_tab: true 时 sender.tab 存在——旧判据会误判成 content script
  const s = sndr({
    url: `chrome-extension://${EXT_ID}/popup/popup.html`,
    tab: { id: 42 },
  });
  assert.equal(classifySender(s, CTX), 'popup', 'sender.tab 存在不影响特权页面识别');
});

test('PASS: 特权页面带查询串/片段仍被识别', () => {
  for (const suffix of ['?x=1', '#top', '?a=1#b']) {
    const s = sndr({ url: `chrome-extension://${EXT_ID}/popup/popup.html${suffix}` });
    assert.equal(classifySender(s, CTX), 'popup', suffix);
  }
});

/* --------------------------- content script --------------------------- */

test('PASS: 网页里的 content script 被识别为 content', () => {
  const s = sndr({ url: 'https://example.com/login', tab: { id: 7 } });
  assert.equal(classifySender(s, CTX), 'content');
});

test('PASS: content script 即使没有 tab 也不被当作特权页面', () => {
  const s = sndr({ url: 'https://example.com/', tab: undefined });
  assert.equal(classifySender(s, CTX), 'unknown', '无 tab 且非扩展 URL → unknown');
});

/* --------------------------- 拒绝路径 --------------------------- */

test('PASS: 错误扩展 ID 被拒绝', () => {
  const s = sndr({
    id: 'ponmlkjihgfedcbaponmlkjihgfedcba',
    url: `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup/popup.html`,
  });
  assert.equal(classifySender(s, CTX), 'unknown');
});

test('PASS: 伪造的扩展 URL 前缀被拒绝（别的扩展 ID 的 URL）', () => {
  const s = sndr({ url: 'chrome-extension://otherid/popup/popup.html' });
  assert.equal(classifySender(s, CTX), 'unknown');
});

test('PASS: 扩展内非白名单页面被拒绝', () => {
  for (const page of ['background/service-worker.js', 'popup/other.html', 'content/content-script.js', '']) {
    const s = sndr({ url: `chrome-extension://${EXT_ID}/${page}` });
    assert.equal(classifySender(s, CTX), 'unknown', page || '(空)');
  }
});

test('PASS: 网页伪造 chrome-extension 前缀被拒绝', () => {
  const s = sndr({
    url: `https://evil.test/chrome-extension://${EXT_ID}/popup/popup.html`,
    tab: { id: 9 },
  });
  assert.equal(classifySender(s, CTX), 'content', 'URL 不是以扩展 base 开头 → 只能算 content');
});

test('PASS: 空 sender / 缺字段被拒绝', () => {
  assert.equal(classifySender(null, CTX), 'unknown');
  assert.equal(classifySender({}, CTX), 'unknown');
  assert.equal(classifySender({ id: EXT_ID }, CTX), 'unknown');
});

test('PASS: 缺 id 时即使 URL 正确也被拒绝', () => {
  const s = { url: `chrome-extension://${EXT_ID}/popup/popup.html` };
  assert.equal(classifySender(s, CTX), 'unknown');
});
