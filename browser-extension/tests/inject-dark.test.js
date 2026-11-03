// 注入辅助与夜间模式的测试。
//
// 注入辅助是**跨模块的基础设施**：每个要在页面上动手的模块都走它。
// 它错了会让所有注入类模块一起坏，所以这块要测得细。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureHostPermission,
  injectInto,
  originPatternOf,
  runInFrame,
} from '../lib/inject.js';
import {
  BRIGHTNESS_RANGE,
  CONTRAST_RANGE,
  SEPIA_RANGE,
  createDarkModule,
  darkToggle,
} from '../lib/modules/dark.js';
import { buildDocument } from './helpers/minidom.js';

/* ============================ origin 提取 ============================ */

function navWith(url) {
  return { getFrame: async () => (url === undefined ? null : { url }) };
}

test('PASS: 从 http(s) 页面取 origin 模式', async () => {
  assert.equal(await originPatternOf(navWith('https://a.b.test/x?y=1'), 1), 'https://a.b.test/*');
  assert.equal(await originPatternOf(navWith('http://local.test:8080/'), 1), 'http://local.test/*');
});

test('FAIL-SAFE: 非 http(s) 页面返回 null（不该弹必然被拒的授权框）', async () => {
  for (const url of ['chrome://settings', 'file:///c:/x', 'about:blank', 'chrome-extension://abc/x.html', '']) {
    assert.equal(await originPatternOf(navWith(url), 1), null, url);
  }
});

test('FAIL-SAFE: 非法 tabId 或 getFrame 抛错时返回 null', async () => {
  assert.equal(await originPatternOf(navWith('https://a.test/'), null), null);
  assert.equal(await originPatternOf(navWith('https://a.test/'), 1.5), null);
  assert.equal(await originPatternOf(navWith(undefined), 1), null);
  assert.equal(
    await originPatternOf({ getFrame: async () => { throw new Error('gone'); } }, 1),
    null
  );
});

/* ============================ 权限 ============================ */

test('PASS: 已有权限时不请求（不反复弹框）', async () => {
  let requested = 0;
  const perms = {
    contains: async () => true,
    request: async () => {
      requested += 1;
      return true;
    },
  };
  assert.equal(await ensureHostPermission(perms, 'https://a.test/*'), true);
  assert.equal(requested, 0);
});

test('PASS: 没有权限时请求一次', async () => {
  let requested = 0;
  const perms = {
    contains: async () => false,
    request: async () => {
      requested += 1;
      return true;
    },
  };
  assert.equal(await ensureHostPermission(perms, 'https://a.test/*'), true);
  assert.equal(requested, 1);
});

test('FAIL-SAFE: 用户拒绝时返回 false', async () => {
  const perms = { contains: async () => false, request: async () => false };
  assert.equal(await ensureHostPermission(perms, 'https://a.test/*'), false);
});

test('FAIL-SAFE: request 抛错按未授权处理', async () => {
  const perms = {
    contains: async () => false,
    request: async () => {
      throw new Error('user gesture required');
    },
  };
  assert.equal(await ensureHostPermission(perms, 'https://a.test/*'), false);
});

test('FAIL-SAFE: 没有 permissions API 时放行（让 executeScript 自己报错）', async () => {
  assert.equal(await ensureHostPermission(undefined, 'https://a.test/*'), true);
});

test('FAIL-SAFE: 空 origin 直接 false', async () => {
  assert.equal(await ensureHostPermission({ contains: async () => true }, null), false);
});

/* ============================ 注入 ============================ */

function fakeScripting(impl) {
  const calls = [];
  return {
    calls,
    async executeScript(opts) {
      calls.push(opts);
      if (impl) return impl(opts);
      return [{ result: { ok: true } }];
    },
  };
}

test('PASS: 只注入主 frame', async () => {
  const scripting = fakeScripting();
  await runInFrame(scripting, 7, () => 1);
  assert.deepEqual(scripting.calls[0].target, { tabId: 7, frameIds: [0] });
});

test('FAIL-SAFE: 注入函数自己返回 ok:false 时不被当成功（三层失败分开）', async () => {
  // executeScript 成功了，函数也跑完了，但它返回 {ok:false, error:'NO_CONTENT'}。
  // 从浏览器角度这是完全成功的调用——不检查这个字段的话，
  // 上层会把失败当成功，于是"注入失败却记成已开启"，用户看到开关自己跳。
  const scripting = fakeScripting(async () => [{ result: { ok: false, error: 'NO_CONTENT' } }]);
  const r = await runInFrame(scripting, 7, () => 1);
  assert.deepEqual(r, { ok: false, error: 'NO_CONTENT' });
});

test('FAIL-SAFE: 注入函数返回 ok:false 但没有 error 时给 INJECTED_FAILED', async () => {
  const scripting = fakeScripting(async () => [{ result: { ok: false } }]);
  const r = await runInFrame(scripting, 7, () => 1);
  assert.equal(r.error, 'INJECTED_FAILED');
});

test('FAIL-SAFE: 空结果返回 NO_RESULT（不是静默成功）', async () => {
  const scripting = fakeScripting(async () => []);
  const r = await runInFrame(scripting, 7, () => 1);
  assert.deepEqual(r, { ok: false, error: 'NO_RESULT' });
});

test('FAIL-SAFE: 无权限错误映射成 HOST_PERMISSION_DENIED', async () => {
  const scripting = fakeScripting(async () => {
    throw new Error('Cannot access contents of the page');
  });
  const r = await runInFrame(scripting, 7, () => 1);
  assert.equal(r.error, 'HOST_PERMISSION_DENIED');
});

test('FAIL-SAFE: 其它错误映射成 INJECT_FAILED（不泄露 e.message）', async () => {
  const scripting = fakeScripting(async () => {
    throw new Error('Frame with id 0 was removed. at /home/user/x.js');
  });
  const r = await runInFrame(scripting, 7, () => 1);
  assert.equal(r.error, 'INJECT_FAILED');
  assert.equal(JSON.stringify(r).includes('home/user'), false);
});

test('FAIL-SAFE: 非法 tabId 不发起注入', async () => {
  const scripting = fakeScripting();
  const r = await runInFrame(scripting, 'x', () => 1);
  assert.equal(r.error, 'BAD_TAB');
  assert.equal(scripting.calls.length, 0);
});

/* ---------------- injectInto 组合 ---------------- */

function deps(overrides = {}) {
  return {
    scripting: overrides.scripting || fakeScripting(),
    permissions: overrides.permissions || { contains: async () => true, request: async () => true },
    webNavigation: overrides.webNavigation || navWith('https://a.test/page'),
  };
}

test('PASS: injectInto 在已是特权时直接注入', async () => {
  const d = deps();
  const r = await injectInto(d, 1, () => 1);
  assert.equal(r.ok, true);
});

test('FAIL-SAFE: injectInto 在非 http 页面返回 NO_ORIGIN 且不注入', async () => {
  const scripting = fakeScripting();
  const r = await injectInto(
    deps({ scripting, webNavigation: navWith('chrome://settings') }),
    1,
    () => 1
  );
  assert.equal(r.error, 'NO_ORIGIN');
  assert.equal(scripting.calls.length, 0);
});

test('FAIL-SAFE: injectInto 在被拒授权后不注入', async () => {
  const scripting = fakeScripting();
  const r = await injectInto(
    deps({
      scripting,
      permissions: { contains: async () => false, request: async () => false },
    }),
    1,
    () => 1
  );
  assert.equal(r.error, 'HOST_PERMISSION_DENIED');
  assert.equal(scripting.calls.length, 0);
});

test('PASS: needPermission:false 时跳过权限检查（卸载场景）', async () => {
  const scripting = fakeScripting();
  let containsCalled = false;
  const r = await injectInto(
    deps({
      scripting,
      permissions: {
        contains: async () => {
          containsCalled = true;
          return false;
        },
        request: async () => false,
      },
    }),
    1,
    () => 1,
    [],
    { needPermission: false }
  );
  assert.equal(r.ok, true);
  assert.equal(containsCalled, false, '不该检查权限');
});

/* ============================ 夜间模式：注入函数 ============================ */

function runInjected(doc, args) {
  const prev = globalThis.document;
  globalThis.document = doc;
  try {
    return darkToggle(args);
  } finally {
    globalThis.document = prev;
  }
}

test('PASS: install 加 class 与样式', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  const r = runInjected(doc, { action: 'install', brightness: 90, contrast: 100, sepia: 0 });

  assert.equal(r.ok, true);
  assert.equal(doc.documentElement.classList.contains('keynest-dark'), true);
  assert.ok(doc.getElementById('keynest-dark-style'));
});

test('FAIL-SAFE: 图片被再反色一次（否则照片变负片）', () => {
  const doc = buildDocument({ body: [{ tag: 'img', attrs: { src: 'a.png' } }] });
  runInjected(doc, { action: 'install', brightness: 90, contrast: 100, sepia: 0 });

  const css = doc.getElementById('keynest-dark-style').textContent;
  assert.ok(/img.*filter:\s*invert\(1\)/s.test(css), '图片没有二次反色');
});

test('FAIL-SAFE: 参数被夹紧（脏数据不会写坏滤镜）', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  const r = runInjected(doc, {
    action: 'install',
    brightness: 9999,
    contrast: -50,
    sepia: NaN,
  });
  assert.equal(r.ok, true);
  assert.ok(r.brightness <= BRIGHTNESS_RANGE[1]);
  assert.ok(r.contrast >= CONTRAST_RANGE[0]);
  assert.equal(r.sepia, 0, 'NaN 应退回默认');
});

test('FAIL-SAFE: 滤镜里不出现 NaN', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  runInjected(doc, { action: 'install', brightness: NaN, contrast: undefined, sepia: 'abc' });
  const css = doc.getElementById('keynest-dark-style').textContent;
  assert.equal(/NaN/.test(css), false, `样式里有 NaN: ${css}`);
  assert.equal(/undefined/.test(css), false);
});

test('PASS: uninstall 完全还原', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  const before = doc.documentElement.className;

  runInjected(doc, { action: 'install', brightness: 90, contrast: 100, sepia: 0 });
  const r = runInjected(doc, { action: 'uninstall' });

  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  assert.equal(doc.documentElement.classList.contains('keynest-dark'), false);
  assert.equal(doc.getElementById('keynest-dark-style'), null);
  assert.equal(doc.documentElement.className, before);
});

test('PASS: 重复 install 只保留一份样式（不叠加）', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  runInjected(doc, { action: 'install', brightness: 90, contrast: 100, sepia: 0 });
  runInjected(doc, { action: 'install', brightness: 70, contrast: 100, sepia: 0 });

  const styles = doc.head.querySelectorAll('style').filter((s) => s.id === 'keynest-dark-style');
  assert.equal(styles.length, 1, '样式被重复插入');
  // 新参数生效
  assert.ok(styles[0].textContent.includes('brightness(70%)'));
});

test('PASS: query 反映当前状态', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  assert.deepEqual(runInjected(doc, { action: 'query' }), { ok: true, active: false });
  runInjected(doc, { action: 'install', brightness: 90, contrast: 100, sepia: 0 });
  assert.deepEqual(runInjected(doc, { action: 'query' }), { ok: true, active: true });
});

test('FAIL-SAFE: 未安装时 uninstall 是无操作', () => {
  const doc = buildDocument({ body: [{ tag: 'p', text: 'x' }] });
  const r = runInjected(doc, { action: 'uninstall' });
  assert.equal(r.removed, false);
});

/* ============================ 夜间模式：模块 ============================ */

test('PASS: 默认关闭（改变页面外观的模块不该自动开）', () => {
  const m = createDarkModule(deps());
  assert.equal(m.defaultEnabled, false);
});

test('PASS: 声明 scripting 与 hostHttps', () => {
  const m = createDarkModule(deps());
  assert.deepEqual([...m.requires].sort(), ['hostHttps', 'scripting']);
});

test('PASS: 三个配置项的范围与默认值', () => {
  const m = createDarkModule(deps());
  assert.equal(m.config.brightness.default, 92);
  assert.equal(m.config.brightness.min, BRIGHTNESS_RANGE[0]);
  assert.equal(m.config.contrast.max, CONTRAST_RANGE[1]);
  assert.equal(m.config.sepia.min, SEPIA_RANGE[0]);
});

test('PASS: dark.toggle 把配置当参数传进注入函数', async () => {
  const scripting = fakeScripting();
  const m = createDarkModule(deps({ scripting }));
  const ctx = { config: { get: (k) => ({ brightness: 80, contrast: 110, sepia: 5 })[k] } };

  const h = m.handlers.find((x) => x.type === 'dark.toggle');
  await h.handle({ tabId: 3, action: 'install' }, ctx);

  const args = scripting.calls[0].args[0];
  assert.equal(args.brightness, 80);
  assert.equal(args.contrast, 110);
  assert.equal(args.sepia, 5);
  assert.equal(args.action, 'install');
});

test('FAIL-SAFE: dark.toggle 拒绝非整数 tabId', async () => {
  const scripting = fakeScripting();
  const m = createDarkModule(deps({ scripting }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');
  for (const tabId of [null, '3', 3.5]) {
    const res = await h.handle({ tabId }, { config: { get: () => 90 } });
    assert.deepEqual(res, { ok: false, error: 'BAD_ARGS' });
  }
  assert.equal(scripting.calls.length, 0);
});

test('PASS: 卸载不请求权限（样式本来就是自己加的）', async () => {
  const scripting = fakeScripting();
  let containsCalled = false;
  const m = createDarkModule(
    deps({
      scripting,
      permissions: {
        contains: async () => {
          containsCalled = true;
          return false;
        },
        request: async () => false,
      },
    })
  );
  const h = m.handlers.find((x) => x.type === 'dark.toggle');
  const res = await h.handle({ tabId: 3, action: 'uninstall' }, { config: { get: () => 90 } });
  assert.equal(res.ok, true);
  assert.equal(containsCalled, false);
});

test('FAIL-SAFE: 无权限时 install 返回 HOST_PERMISSION_DENIED', async () => {
  const m = createDarkModule(
    deps({ permissions: { contains: async () => false, request: async () => false } })
  );
  const h = m.handlers.find((x) => x.type === 'dark.toggle');
  const res = await h.handle({ tabId: 3, action: 'install' }, { config: { get: () => 90 } });
  assert.equal(res.error, 'HOST_PERMISSION_DENIED');
});

/* ============================ 按站点记忆 ============================ */

/** 带记忆配置的 ctx。注入结果可控，用来验"失败不写名单"。 */
function memCtx(initial = {}, injection = { ok: true }) {
  const store = { darkSites: '[]', remember: true, brightness: 90, contrast: 100, sepia: 0, ...initial };
  const ctx = {
    store,
    config: {
      get: (k) => store[k],
      set: async (k, v) => {
        store[k] = v;
      },
    },
  };
  return { ctx, store, injection };
}

function memDeps(injection = {}) {
  return {
    scripting: {
      async executeScript() {
        return [{ result: injection }];
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    webNavigation: { getFrame: async () => ({ url: 'https://a.test/page' }) },
  };
}

test('PASS: 开启后把站点写进名单', async () => {
  const { ctx, store } = memCtx();
  const m = createDarkModule(memDeps({ ok: true, brightness: 90 }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'install', host: 'a.test' }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), ['a.test']);
});

test('PASS: 关闭只是本次退出，**保留**站点记忆', async () => {
  // 用户在页面上点「关闭夜间模式」，往往只是想看一眼原始页面。
  // 顺手把这个站点的记忆也删掉的话，下次还得重新点开，
  // 而他并不知道刚才删掉了什么。
  //
  // 与阅读模式（reader.toggle）已经是这个语义，这里对齐。
  const { ctx, store } = memCtx({ darkSites: '["a.test"]' });
  const m = createDarkModule(memDeps({ ok: true, removed: true }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'uninstall', host: 'a.test' }, ctx);
  assert.deepEqual(
    JSON.parse(store.darkSites),
    ['a.test'],
    '本次退出不该删掉站点记忆'
  );
});

test('PASS: forget:true 才移除站点记忆', async () => {
  const { ctx, store } = memCtx({ darkSites: '["a.test"]' });
  const m = createDarkModule(memDeps({ ok: true, removed: true }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'uninstall', host: 'a.test', forget: true }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), []);
});

test('PASS: dark.forget 从名单里移除指定站点', async () => {
  const { ctx, store } = memCtx({ darkSites: '["a.test","b.test"]' });
  const m = createDarkModule(memDeps({ ok: true }));
  const h = m.handlers.find((x) => x.type === 'dark.forget');

  const res = await h.handle({ host: 'a.test' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  assert.deepEqual(JSON.parse(store.darkSites), ['b.test']);
});

test('FAIL-SAFE: dark.forget 缺 host 时拒绝', async () => {
  const { ctx } = memCtx({ darkSites: '["a.test"]' });
  const m = createDarkModule(memDeps({ ok: true }));
  const h = m.handlers.find((x) => x.type === 'dark.forget');

  const res = await h.handle({}, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'BAD_ARGS');
});

test('FAIL-SAFE: 注入失败时不写名单（否则开关会自己跳）', async () => {
  // 注入失败还记成"已开启"，下次页面加载会自动尝试、又失败，
  // 用户看到的是"开关自己跳"。
  const { ctx, store } = memCtx();
  const m = createDarkModule(memDeps({ ok: false, error: 'NO_CONTENT' }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'install', host: 'a.test' }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), [], '失败却写了名单');
});

test('FAIL-SAFE: remember:false 时不写名单（只想影响当前页面）', async () => {
  const { ctx, store } = memCtx({ remember: false });
  const m = createDarkModule(memDeps({ ok: true, brightness: 90 }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'install', host: 'a.test' }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), []);
});

test('PASS: 没传 host 时从 tab URL 推断', async () => {
  const { ctx, store } = memCtx();
  const m = createDarkModule(memDeps({ ok: true, brightness: 90 }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'install' }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), ['a.test'], '没从 tab 推断出 host');
});

test('FAIL-SAFE: 传了非法 host 时退回 tab 推断（不是直接失败）', async () => {
  const { ctx, store } = memCtx();
  const m = createDarkModule(memDeps({ ok: true, brightness: 90 }));
  const h = m.handlers.find((x) => x.type === 'dark.toggle');

  await h.handle({ tabId: 1, action: 'install', host: 'https://x.test/a' }, ctx);
  assert.deepEqual(JSON.parse(store.darkSites), ['a.test']);
});

test('PASS: dark.should-apply 告诉页面该不该自动开', async () => {
  const { ctx } = memCtx({ darkSites: '["a.test"]' });
  const m = createDarkModule(memDeps());
  const h = m.handlers.find((x) => x.type === 'dark.should-apply');

  assert.deepEqual(await h.handle({ host: 'www.a.test' }, ctx), { ok: true, apply: true });
  assert.deepEqual(await h.handle({ host: 'b.test' }, ctx), { ok: true, apply: false });
});

test('FAIL-SAFE: dark.should-apply 缺 host 被拒', async () => {
  const { ctx } = memCtx();
  const m = createDarkModule(memDeps());
  const h = m.handlers.find((x) => x.type === 'dark.should-apply');
  for (const host of ['', null, 123]) {
    assert.deepEqual(await h.handle({ host }, ctx), { ok: false, error: 'BAD_ARGS' });
  }
});

test('PASS: dark.sites 返回当前名单', async () => {
  const { ctx } = memCtx({ darkSites: '["b.test","a.test"]' });
  const m = createDarkModule(memDeps());
  const h = m.handlers.find((x) => x.type === 'dark.sites');
  assert.deepEqual((await h.handle({}, ctx)).list, ['b.test', 'a.test']);
});
