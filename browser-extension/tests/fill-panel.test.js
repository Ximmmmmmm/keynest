// 密码填充面板的测试。
//
// # 为什么关心失败提示
//
// 扩展连不上桌面程序有**两种完全不同的原因**：
//
// 1. `NATIVE_HOST_MISSING` —— 浏览器根本没找到桥接宿主。
//    要么没装，要么没在钥巢的「设置 → 浏览器」里登记。
// 2. `HOST_DISCONNECTED` —— 宿主找到了，但桌面程序没运行。
//
// 两者都提示「KeyNest 未运行」的话，用户会去开钥巢——
// 而开了也没用，因为真正缺的是**桥接登记**。
// 用户会被引导到错误的动作上，然后觉得「这软件有问题」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFillPanel } from '../popup/panels.js';

/** 造一个记录 host.el 调用的假 host。 */
function fakeHost(sendResult) {
  const texts = [];
  return {
    texts,
    section: {
      children: [],
      append(...c) {
        this.children.push(...c);
      },
    },
    el(tag, cls, text) {
      const node = { tag, cls, text, children: [] };
      texts.push({ cls, text });
      return node;
    },
    async send(type) {
      return typeof sendResult === 'function' ? sendResult(type) : sendResult;
    },
    error() {},
  };
}

/** 跑一次填充面板的渲染，返回它显示的所有文本。 */
async function renderFill(sendResult, getTabId = () => 1) {
  const panel = createFillPanel({ getTabId });
  const host = fakeHost(sendResult);
  await panel.render(host);
  return host.texts;
}

test('PASS: 宿主没被启动时提示「浏览器桥接没有就绪」', async () => {
  const texts = await renderFill({ ok: false, error: 'HOST_DISCONNECTED' });
  const all = texts.map((t) => t.text).join(' | ');
  assert.ok(
    all.includes('浏览器桥接') || all.includes('设置'),
    `提示应当指向桥接安装：${all}`
  );
  assert.ok(
    !all.includes('请先打开钥巢'),
    `不该让用户去开钥巢（真正缺的是桥接登记）：${all}`
  );
});

test('PASS: 桌面程序没跑时提示「钥巢没有运行」', async () => {
  const texts = await renderFill({ ok: false, error: 'GUI_NOT_RUNNING' });
  const all = texts.map((t) => t.text).join(' | ');
  assert.ok(all.includes('钥巢'), `应当提示打开桌面程序：${all}`);
  assert.ok(
    !all.includes('浏览器桥接'),
    `宿主在，不该让用户去装桥接：${all}`
  );
});

test('PASS: 其它失败给通用提示，不崩溃', async () => {
  const texts = await renderFill({ ok: false, error: 'SOMETHING_ELSE' });
  assert.ok(texts.length > 0, '应当有提示');
  const all = texts.map((t) => t.text).join(' | ');
  assert.ok(all.includes('钥巢'), all);
});

test('PASS: send 返回 null 也不崩溃', async () => {
  const texts = await renderFill(null);
  assert.ok(texts.length > 0);
});

test('PASS: 桌面程序锁定时提示解锁', async () => {
  const texts = await renderFill({ ok: true, data: { locked: true } });
  const all = texts.map((t) => t.text).join(' | ');
  assert.ok(all.includes('锁定'), all);
});

test('PASS: 桌面程序已解锁但没有匹配条目', async () => {
  const texts = await renderFill({ ok: true, data: { locked: false } });
  const all = texts.map((t) => t.text).join(' | ');
  assert.ok(all.includes('没有匹配'), all);
});
