// 浏览器桥接面板的测试。
//
// # 为什么这个面板重要
//
// 浏览器只在注册表里找 Native Messaging 宿主，清单里的
// `allowed_origins` 必须写**精确的扩展 ID**。而未发布到商店的扩展，
// ID 由安装路径的哈希决定——**每台机器都不一样**。
//
// 所以桌面程序没法自己猜，只能由用户把 ID 告诉它。
// 而这个 ID 只有扩展自己知道（`chrome.runtime.id`）。
//
// 少了这个面板，用户看到的是「KeyNest 未运行」——
// 而实际上桌面程序在运行、只是不知道该允许哪个扩展。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgePanel } from '../popup/panels.js';

/** 造一个假的 host，收集它被要求创建的元素。 */
function fakeHost() {
  const created = [];
  return {
    created,
    el(tag, cls, text) {
      const node = { tag, cls, text, children: [] };
      created.push(node);
      return node;
    },
    get section() {
      return {
        children: [],
        append(...c) {
          this.children.push(...c);
        },
      };
    },
  };
}

/**
 * 最小 DOM stub。
 *
 * 面板会真的建元素（`document.createElement`），Node 里没有 DOM。
 * 只实现面板用到的那几个方法。
 */
function stubDocument() {
  const make = (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    listeners: {},
    append(...c) {
      this.children.push(...c);
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    set className(v) {
      this._className = v;
    },
    get className() {
      return this._className || '';
    },
  });
  return {
    createElement: (tag) => make(tag),
  };
}

/** 在给定的扩展 ID 下跑一次渲染。 */
async function renderWith(extensionId) {
  const prevChrome = globalThis.chrome;
  const prevDocument = globalThis.document;
  globalThis.chrome = { runtime: { id: extensionId } };
  globalThis.document = stubDocument();
  try {
    const host = fakeHost();
    const panel = createBridgePanel();
    await panel.render(host);
    return host;
  } finally {
    globalThis.chrome = prevChrome;
    globalThis.document = prevDocument;
  }
}

test('PASS: 面板显示扩展 ID', async () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const host = await renderWith(id);

  // 面板里必须有这个 ID 的文本
  const all = JSON.stringify(host.created);
  assert.ok(all.includes(id), `面板里应当出现扩展 ID：${all}`);
});

test('PASS: 面板排在最前（order 最小）', () => {
  const panel = createBridgePanel();
  assert.ok(typeof panel.order === 'number', '必须有 order');
  // 与其它面板比较：fill 是 10，所以桥接面板必须 < 10
  assert.ok(panel.order < 10, `order=${panel.order} 应当排在填充面板之前`);
});

test('PASS: 面板 id 唯一', () => {
  assert.equal(createBridgePanel().id, 'bridge');
});

test('PASS: 没有 chrome.runtime 时不崩（不显示任何东西）', async () => {
  const prevChrome = globalThis.chrome;
  const prevDocument = globalThis.document;
  globalThis.chrome = { runtime: undefined };
  globalThis.document = stubDocument();
  try {
    const host = fakeHost();
    const panel = createBridgePanel();
    await panel.render(host);
    assert.equal(host.created.length, 0);
  } finally {
    globalThis.chrome = prevChrome;
    globalThis.document = prevDocument;
  }
});

test('PASS: 连 chrome 都没有时也不崩', async () => {
  const prevChrome = globalThis.chrome;
  const prevDocument = globalThis.document;
  globalThis.chrome = undefined;
  globalThis.document = stubDocument();
  try {
    const host = fakeHost();
    const panel = createBridgePanel();
    await panel.render(host);
    assert.equal(host.created.length, 0);
  } finally {
    globalThis.chrome = prevChrome;
    globalThis.document = prevDocument;
  }
});
