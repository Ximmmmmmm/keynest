// 面板系统的测试。
//
// 这个文件只测 PanelHost 的装配逻辑，不测具体面板的内容。
// 重点：注册校验、模块过滤、单个面板失败不影响其他、渲染顺序。
//
// 用最小 DOM 替身而不是引入 jsdom——这里只需要 append/replaceChildren/
// dataset/classList 这几样。

import test from 'node:test';
import assert from 'node:assert/strict';

import { PanelHost } from '../popup/panel-host.js';

/* ============================ 最小 DOM 替身 ============================ */

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(c) {
    this.set.add(c);
  }
  remove(c) {
    this.set.delete(c);
  }
  contains(c) {
    return this.set.has(c);
  }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.classList = new FakeClassList();
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  /** 递归找带某个 class 的后代（测试断言用）。 */
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      if (c instanceof FakeElement) c.findAll(pred, out);
    }
    return out;
  }
}

/**
 * 把全局 document 临时换成替身（PanelHost 用 document.createElement）。
 *
 * **必须 await fn 的返回值**：`renderAll` 是异步的，
 * 同步的 try/finally 会在 Promise 结算前就把 document 恢复回去，
 * 于是面板里的 createElement 全部拿到真的 document（在 node 里不存在）而失败。
 */
async function withFakeDocument(fn) {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
  };
  try {
    return await fn();
  } finally {
    globalThis.document = prev;
  }
}

function makeHost(overrides = {}) {
  const root = new FakeElement('main');
  const sent = [];
  let lastError = null;
  const host = new PanelHost({
    root,
    send: async (type, msg) => {
      sent.push({ type, msg });
      if (type === 'modules.list') {
        return overrides.moduleList || {
          ok: true,
          modules: [
            { id: 'vault', enabled: true },
            { id: 'adblock', enabled: overrides.adblockEnabled !== false },
          ],
        };
      }
      return { ok: true };
    },
    setError: (t) => {
      lastError = t;
    },
  });
  return { host, root, sent, lastError: () => lastError };
}

/* ============================ 注册校验 ============================ */

test('FAIL-SAFE: 缺 id 的面板被拒绝', async () => {
  await withFakeDocument(() => {
    const { host } = makeHost();
    for (const bad of [{}, { id: '' }, { id: 123 }, null]) {
      assert.throws(() => host.register(bad), /panel\.id/);
    }
  });
});

test('FAIL-SAFE: 缺 render 的面板被拒绝', async () => {
  await withFakeDocument(() => {
    const { host } = makeHost();
    assert.throws(() => host.register({ id: 'x' }), /render/);
  });
});

test('FAIL-SAFE: 重复 id 被拒绝（不静默覆盖）', async () => {
  await withFakeDocument(() => {
    const { host } = makeHost();
    host.register({ id: 'a', render: () => {} });
    assert.throws(
      () => host.register({ id: 'a', render: () => {} }),
      /重复注册/
    );
    assert.deepEqual(host.ids(), ['a'], '不该覆盖已有面板');
  });
});

/* ============================ 渲染 ============================ */

test('PASS: 面板按 order 排序渲染', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    const seen = [];
    host.register({ id: 'c', order: 30, render: () => seen.push('c') });
    host.register({ id: 'a', order: 10, render: () => seen.push('a') });
    host.register({ id: 'b', order: 20, render: () => seen.push('b') });

    await host.renderAll();
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.equal(root.children.length, 3);
  });
});

test('PASS: 未声明 order 的排在后面，且注册顺序稳定', async () => {
  await withFakeDocument(async () => {
    const { host } = makeHost();
    const seen = [];
    host.register({ id: 'z1', render: () => seen.push('z1') });
    host.register({ id: 'first', order: 1, render: () => seen.push('first') });
    host.register({ id: 'z2', render: () => seen.push('z2') });

    await host.renderAll();
    assert.deepEqual(seen, ['first', 'z1', 'z2']);
  });
});

test('PASS: 模块未启用的面板整块跳过，连容器都不创建', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost({ adblockEnabled: false });
    let adblockRendered = false;
    host.register({ id: 'fill', moduleId: 'vault', render: () => {} });
    host.register({
      id: 'adblock',
      moduleId: 'adblock',
      render: () => {
        adblockRendered = true;
      },
    });

    await host.renderAll();
    assert.equal(adblockRendered, false, '禁用的模块不该渲染');
    assert.equal(root.children.length, 1, '只该有 fill 的容器');
    assert.equal(root.children[0].dataset.panel, 'fill');
  });
});

test('PASS: 不声明 moduleId 的面板永远渲染（核心面板）', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost({
      moduleList: { ok: true, modules: [] }, // 连 vault 都没返回
    });
    let rendered = false;
    host.register({ id: 'core', render: () => { rendered = true; } });
    await host.renderAll();
    assert.equal(rendered, true);
    assert.equal(root.children.length, 1);
  });
});

test('FAIL-SAFE: 单个面板抛错不影响其他面板', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    let secondRendered = false;

    host.register({
      id: 'broken',
      order: 1,
      render: () => {
        throw new Error('内部细节：/home/user/secret.txt');
      },
    });
    host.register({
      id: 'ok',
      order: 2,
      render: () => {
        secondRendered = true;
      },
    });

    await host.renderAll();
    assert.equal(secondRendered, true, '后面的面板必须照常渲染');
    assert.equal(root.children.length, 2);

    // 坏掉的容器里有一条占位文字，且不含异常详情
    const broken = root.children[0];
    assert.equal(broken.dataset.panel, 'broken');
    const text = JSON.stringify(broken.findAll(() => true).map((e) => e.textContent));
    assert.equal(
      text.includes('secret.txt'),
      false,
      '不该把 e.message 暴露给用户'
    );
  });
});

test('PASS: renderAll 会清掉上一次的内容（刷新不重复堆叠）', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    host.register({ id: 'a', render: () => {} });

    await host.renderAll();
    await host.renderAll();
    assert.equal(root.children.length, 1, '第二次渲染不该留下旧的容器');
  });
});

/* ============================ 模块状态 ============================ */

test('FAIL-SAFE: modules.list 失败时所有依赖模块的面板都不渲染', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost({
      moduleList: { ok: false, error: 'HOST_INIT_FAILED' },
    });
    let rendered = false;
    host.register({ id: 'm', moduleId: 'adblock', render: () => { rendered = true; } });
    await host.renderAll();
    assert.equal(rendered, false, '状态未知时应保守不渲染');
    assert.equal(root.children.length, 0);
  });
});

test('FAIL-SAFE: modules.list 抛异常时同理（不向上抛）', async () => {
  await withFakeDocument(async () => {
    const root = new FakeElement('main');
    const host = new PanelHost({
      root,
      send: async (type) => {
        if (type === 'modules.list') throw new Error('boom');
        return { ok: true };
      },
    });
    let rendered = false;
    host.register({ id: 'm', moduleId: 'adblock', render: () => { rendered = true; } });
    await host.renderAll();
    assert.equal(rendered, false);
  });
});

test('PASS: 只问一次 modules.list（不是每个面板各问一次）', async () => {
  await withFakeDocument(async () => {
    const { host, sent } = makeHost();
    host.register({ id: 'a', moduleId: 'vault', render: () => {} });
    host.register({ id: 'b', moduleId: 'adblock', render: () => {} });
    host.register({ id: 'c', moduleId: 'registry', render: () => {} });
    await host.renderAll();

    const listCalls = sent.filter((s) => s.type === 'modules.list');
    assert.equal(listCalls.length, 1, `问了 ${listCalls.length} 次`);
  });
});

/* ============================ 渲染上下文 ============================ */

test('PASS: 面板拿到 section 与 send', async () => {
  await withFakeDocument(async () => {
    const { host } = makeHost();
    let got = null;
    host.register({
      id: 'a',
      render: async (ctx) => {
        got = { isEl: ctx.section instanceof FakeElement, hasSend: typeof ctx.send === 'function' };
        await ctx.send('anything');
      },
    });
    await host.renderAll();
    assert.deepEqual(got, { isEl: true, hasSend: true });
  });
});

test('PASS: el 辅助函数创建并挂载元素', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    host.register({
      id: 'a',
      render: (ctx) => {
        const p = ctx.el('p', 'note', '你好');
        assert.equal(p.textContent, '你好');
        assert.equal(p.className, 'note');
      },
    });
    await host.renderAll();
    const section = root.children[0];
    assert.equal(section.children.length, 1);
    assert.equal(section.children[0].textContent, '你好');
  });
});

test('PASS: 面板内的 error 会写进全局错误条', async () => {
  await withFakeDocument(async () => {
    const { host, lastError } = makeHost();
    host.register({
      id: 'a',
      render: (ctx) => ctx.error('出错了'),
    });
    await host.renderAll();
    assert.equal(lastError(), '出错了');
  });
});

/* ============================ available 判定 ============================ */

test('PASS: available 返回 false 时连容器都不创建', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    let rendered = false;
    host.register({
      id: 'skip',
      available: () => false,
      render: () => {
        rendered = true;
      },
    });
    host.register({ id: 'keep', render: () => {} });

    await host.renderAll();
    assert.equal(rendered, false);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].dataset.panel, 'keep');
  });
});

test('PASS: available 支持异步', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    host.register({ id: 'a', available: async () => true, render: () => {} });
    await host.renderAll();
    assert.equal(root.children.length, 1);
  });
});

test('FAIL-SAFE: available 抛错按不可用处理（不冒空框，也不传播）', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    let rendered = false;
    host.register({
      id: 'boom',
      available: () => {
        throw new Error('判定失败');
      },
      render: () => {
        rendered = true;
      },
    });
    await host.renderAll();
    assert.equal(rendered, false);
    assert.equal(root.children.length, 0);
  });
});

test('PASS: 没有 available 的面板默认可用', async () => {
  await withFakeDocument(async () => {
    const { host, root } = makeHost();
    host.register({ id: 'a', render: () => {} });
    await host.renderAll();
    assert.equal(root.children.length, 1);
  });
});
