// 主世界 URL 观察器的测试。
//
// # 为什么这个功能需要单独测
//
// 阶段 3.6 以为"SPA 换路由后重新应用"已经做完了——单元测试也全绿。
// 但真实浏览器里**根本不工作**：
//
// 内容脚本跑在**隔离世界**，它看到的是一份独立的 `window` 与 `history`。
// 页面自己的脚本跑在**主世界**，调的是主世界的 `history.pushState`——
// 隔离世界给 history 打的补丁**根本不会被触发**。
//
// 表现极具迷惑性：补丁装上了（`__keynestPatched` 为 true）、
// 页面也真的换了路由，但两者之间没有连接。
//
// 所以这里测的是主世界观察器本身，以及它与隔离世界的连接方式。

import test from 'node:test';
import assert from 'node:assert/strict';

import { mainWorldUrlWatcher } from '../lib/auto-apply.js';

/** 造一个最小的 window 替身。 */
function fakeWindow() {
  const listeners = new Map();
  const posted = [];
  const hist = {
    pushState(s, t, u) {
      hist.calls.push({ name: 'pushState', self: this, state: s, url: u });
      return 'push-return';
    },
    replaceState(s, t, u) {
      hist.calls.push({ name: 'replaceState', self: this, state: s, url: u });
      return 'replace-return';
    },
    calls: [],
  };
  return {
    history: hist,
    posted,
    location: { href: 'https://a.test/spa' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    postMessage(data) {
      posted.push(data);
    },
    fire(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
    __keynestUrlWatcher: false,
  };
}

/**
 * 在假的 window 上跑注入函数。
 *
 * # 为什么不恢复全局
 *
 * 注入函数里的 `notify` 闭包捕获的是**它被定义时的全局** `window`。
 * 如果在 `inject()` 返回后把全局还原掉，闭包里的 `window` 指向的还是
 * 那个假对象——这没问题；但反过来，闭包若在**调用时**才去读全局，
 * 就会读到已还原的真实 globalThis（Node 里没有 window）而抛错。
 *
 * 所以这里用 `withWindow` 把整个用例包起来：全局在用例期间一直是假的，
 * 用例结束后再还原。
 */
function withWindow(win, fn) {
  const prevWindow = globalThis.window;
  const prevHistory = globalThis.history;
  const prevLocation = globalThis.location;
  globalThis.window = win;
  globalThis.history = win.history;
  globalThis.location = win.location;
  try {
    return fn();
  } finally {
    globalThis.window = prevWindow;
    globalThis.history = prevHistory;
    globalThis.location = prevLocation;
  }
}

/** 注入并**留在**假窗口里（后续断言还要用）。 */
function inject(win, token = 'tok-123') {
  globalThis.window = win;
  globalThis.history = win.history;
  globalThis.location = win.location;
  return mainWorldUrlWatcher({ token });
}

test('PASS: 注入后给 pushState 与 replaceState 都打了补丁', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    const r = inject(win);
    assert.equal(r.ok, true);
    assert.equal(r.patched, 2);
  });
});

test('FAIL-SAFE: 原函数必须被转发（含返回值与 this）', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    inject(win);
    const ret = win.history.pushState({ a: 1 }, 't', '/x');
    assert.equal(ret, 'push-return', '返回值被吞了');
    assert.equal(win.history.calls.length, 1);
    assert.equal(win.history.calls[0].self, win.history, 'this 丢了');
  });
});

test('PASS: 调用 pushState 会 postMessage 通知（带 token）', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    inject(win, 'tok-abc');
    win.history.pushState({}, '', '/next');

    assert.equal(win.posted.length, 1);
    assert.equal(win.posted[0].__keynestUrlWatch, 'tok-abc');
    assert.equal(win.posted[0].url, 'https://a.test/spa');
  });
});

test('PASS: 重复注入不叠加补丁', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    inject(win);
    const r2 = inject(win);
    assert.equal(r2.already, true);
    win.history.pushState({}, '', '/x');
    assert.equal(win.posted.length, 1, `通知了 ${win.posted.length} 次，说明补丁套了两层`);
  });
});

test('FAIL-SAFE: 缺 token 时不注入（避免发出无法验证的消息）', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    const r = inject(win, '');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NO_TOKEN');
    assert.equal(win.history.pushState.__keynestPatched, undefined);
  });
});

test('PASS: popstate 与 hashchange 也触发通知', () => {
  const win = fakeWindow();
  withWindow(win, () => {
    inject(win);
    win.fire('popstate');
    win.fire('hashchange');
    assert.equal(win.posted.length, 2);
  });
});

test('FAIL-SAFE: history 属性只读时不影响其它（返回 patched 计数）', () => {
  const win = fakeWindow();
  // 把 replaceState 变成不可写
  const original = win.history.replaceState;
  Object.defineProperty(win.history, 'replaceState', {
    value: original,
    writable: false,
    configurable: false,
  });

  withWindow(win, () => {
    const r = inject(win);
    assert.equal(r.ok, true);
    // 至少 pushState 那一个打上了
    assert.ok(r.patched >= 1, `patched=${r.patched}`);
  });
});
