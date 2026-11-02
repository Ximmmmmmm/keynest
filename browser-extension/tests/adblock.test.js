// 广告过滤模块的测试：规则安装、豁免、错误处理。
//
// 这里测的是「模块」而不是「规则引擎」（后者在 filters.test.js）。
// 重点在**与浏览器交互的部分**：安装顺序、失败回退、id 冲突、豁免优先级。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOW_RULE_ID_BASE,
  RULESET_ID,
  createAdblockModule,
} from '../lib/modules/adblock.js';
import { MODES } from '../lib/filters/rules.js';

/**
 * Chrome dNR 规则的字段白名单。
 *
 * 假 dNR 如果什么都收，就会出现「单元测试全绿、真实浏览器整批拒绝」——
 * 阶段 2.9 真的踩到了：条件里写了 `thirdParty: true`，Chrome 要的是
 * `domainType: 'thirdParty'`。所以这里按 Chrome 的实际约束做校验。
 */
const CONDITION_KEYS = new Set([
  'urlFilter',
  'regexFilter',
  'isUrlFilterCaseSensitive',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'requestDomains',
  'excludedRequestDomains',
  'resourceTypes',
  'excludedResourceTypes',
  'domainType',
  'requestMethods',
  'excludedRequestMethods',
  'tabIds',
  'excludedTabIds',
]);

function assertRuleShape(rule) {
  for (const key of Object.keys(rule.condition)) {
    if (!CONDITION_KEYS.has(key)) {
      throw new Error(`Unexpected property: '${key}'`);
    }
  }
  if (rule.condition.domainType !== undefined) {
    if (!['firstParty', 'thirdParty'].includes(rule.condition.domainType)) {
      throw new Error('Invalid domainType');
    }
  }
}

/** 假 dNR：记录调用，能模拟失败，并按 Chrome 的字段约束校验规则。 */
function fakeDnr(opts = {}) {
  const state = {
    installed: [],
    calls: { get: 0, update: 0 },
    /** 每次 update 收到的参数，用于断言原子性 */
    updates: [],
  };
  return {
    state,
    async getDynamicRules() {
      state.calls.get += 1;
      if (opts.failGet) throw new Error('not available');
      return state.installed.map((r) => ({ id: r.id }));
    },
    async updateDynamicRules(arg) {
      state.calls.update += 1;
      if (opts.failUpdate) throw new Error(opts.failUpdate);
      for (const rule of arg.addRules || []) assertRuleShape(rule);
      state.updates.push(arg);
      // 模拟浏览器语义：先删后加
      const removeSet = new Set(arg.removeRuleIds || []);
      state.installed = state.installed.filter((r) => !removeSet.has(r.id));
      state.installed.push(...(arg.addRules || []));
    },
  };
}

function mod(dnr) {
  return createAdblockModule({ dnr });
}

/* ============================ 模块声明 ============================ */

test('PASS: 默认关闭（改变网页行为的模块不该默认开启）', () => {
  const m = mod(fakeDnr());
  assert.equal(m.defaultEnabled, false);
});

test('PASS: 声明了正确的权限', () => {
  const m = mod(fakeDnr());
  assert.deepEqual([...m.requires].sort(), ['declarativeNetRequest', 'hostHttps']);
});

test('PASS: 配置项 mode 默认 basic，取值与 MODES 一致', () => {
  const m = mod(fakeDnr());
  assert.equal(m.config.mode.type, 'enum');
  assert.equal(m.config.mode.default, 'basic');
  assert.deepEqual([...m.config.mode.values], [...MODES]);
});

/* ============================ 安装 ============================ */

test('PASS: 安装 basic 规则', async () => {
  const dnr = fakeDnr();
  const r = await mod(dnr).applyRules('basic');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'basic');
  assert.ok(r.rules > 0);
  assert.equal(dnr.state.calls.update, 1);
});

test('FAIL-SAFE: off 档会清空已有规则', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic');
  const before = dnr.state.installed.length;
  assert.ok(before > 0);

  const r = await m.applyRules('off');
  assert.equal(r.ok, true);
  assert.equal(r.rules, 0);
  assert.equal(dnr.state.installed.length, 0, 'off 必须真的清空，不是"有规则但不装"');
});

test('FAIL-SAFE: 安装是原子的（remove 与 add 在同一次调用里）', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic');
  await m.applyRules('strict');

  const last = dnr.state.updates.at(-1);
  assert.ok(Array.isArray(last.removeRuleIds));
  assert.ok(Array.isArray(last.addRules));
  assert.equal(dnr.state.calls.update, 2, '每次切换只该有一次 update');
});

test('FAIL-SAFE: 切档位时旧规则被全部替换，不留残留', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('strict');
  const strictCount = dnr.state.installed.length;

  await m.applyRules('basic');
  const basicCount = dnr.state.installed.length;
  assert.ok(basicCount < strictCount, 'basic 的规则数应少于 strict');

  // 没有 strict 专属的规则残留
  const ids = new Set(dnr.state.installed.map((r) => r.id));
  assert.equal(ids.size, dnr.state.installed.length, '有重复 id 残留');
});

test('FAIL-SAFE: 规则 id 单调增长时不会与豁免规则冲突', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('strict', ['example.test']);
  const ids = dnr.state.installed.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'id 冲突会让整批安装失败');

  const allow = dnr.state.installed.find((r) => r.action.type === 'allowAllRequests');
  assert.ok(allow);
  assert.ok(allow.id >= ALLOW_RULE_ID_BASE);
});

/* ============================ 豁免 ============================ */

test('PASS: 豁免规则用 allowAllRequests 且优先级最高', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic', ['news.test']);

  const allow = dnr.state.installed.find((r) => r.action.type === 'allowAllRequests');
  assert.ok(allow, '豁免规则没装');
  assert.equal(allow.priority, 100);
  assert.deepEqual(allow.condition.requestDomains, ['news.test']);
  assert.deepEqual([...allow.condition.resourceTypes].sort(), ['main_frame', 'sub_frame']);

  // 优先级必须高于所有 block 规则
  const maxBlockPriority = Math.max(
    ...dnr.state.installed.filter((r) => r.action.type === 'block').map((r) => r.priority)
  );
  assert.ok(allow.priority > maxBlockPriority, `豁免(${allow.priority}) 必须高于拦截(${maxBlockPriority})`);
});

test('FAIL-SAFE: 豁免名单里的脏数据被丢弃，不生成规则', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic', ['', null, 'a b', 'a/b', 'evil..com', 'good.test']);
  const allows = dnr.state.installed.filter((r) => r.action.type === 'allowAllRequests');
  assert.equal(allows.length, 1, '只有 good.test 该生成规则');
  assert.deepEqual(allows[0].condition.requestDomains, ['good.test']);
});

test('PASS: 多个豁免域名各自生成规则', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic', ['a.test', 'b.test']);
  const allows = dnr.state.installed.filter((r) => r.action.type === 'allowAllRequests');
  assert.equal(allows.length, 2);
  assert.equal(new Set(allows.map((r) => r.id)).size, 2, 'id 不能重复');
});

test('FAIL-SAFE: 豁免域名大小写与尾点被规范化', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic', ['News.TEST.']);
  const allow = dnr.state.installed.find((r) => r.action.type === 'allowAllRequests');
  assert.deepEqual(allow.condition.requestDomains, ['news.test']);
});

/* ============================ 错误处理 ============================ */

test('FAIL-SAFE: dNR 不可用时返回稳定错误码，不抛异常', async () => {
  const dnr = fakeDnr({ failGet: true });
  const r = await mod(dnr).applyRules('basic');
  assert.deepEqual(r, { ok: false, error: 'DNR_UNAVAILABLE' });
});

test('FAIL-SAFE: 安装失败返回错误码并记下 lastError', async () => {
  const dnr = fakeDnr({ failUpdate: 'Invalid rule: bad id' });
  const m = mod(dnr);
  const r = await m.applyRules('basic');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'RULE_INVALID');

  const status = await m.handlers.find((h) => h.type === 'adblock.status').handle({}, {});
  assert.equal(status.lastError, 'RULE_INVALID', 'lastError 要能被设置页看到');
});

test('FAIL-SAFE: 失败后不留下半套规则', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic');
  const snapshot = dnr.state.installed.length;

  // 第二次安装失败
  dnr.updateDynamicRules = async () => {
    throw new Error('Invalid rule');
  };
  const r = await m.applyRules('strict');
  assert.equal(r.ok, false);
  assert.equal(dnr.state.installed.length, snapshot, '失败后规则数不该变');
});

test('FAIL-SAFE: 未知档位被拒绝，不动现有规则', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('basic');
  const before = dnr.state.installed.length;

  const r = await m.applyRules('paranoid');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BAD_MODE');
  assert.equal(dnr.state.installed.length, before);
});

test('PASS: 不同错误消息映射到不同错误码', async () => {
  const cases = [
    ['Rule with id 1000 does not have a unique ID', 'RULE_ID_CONFLICT'],
    ['This request is not allowed', 'DNR_PERMISSION'],
    ['Invalid rule condition', 'RULE_INVALID'],
    ['something else entirely', 'DNR_FAILED'],
  ];
  for (const [msg, code] of cases) {
    const dnr = fakeDnr({ failUpdate: msg });
    const r = await mod(dnr).applyRules('basic');
    assert.equal(r.error, code, msg);
  }
});

/* ============================ 诊断接口 ============================ */

test('PASS: adblock.explain 指出命中的规则', async () => {
  const m = mod(fakeDnr());
  const h = m.handlers.find((x) => x.type === 'adblock.explain');
  const ctx = { config: { get: () => 'basic' } };
  const res = await h.handle({ host: 'ads.doubleclick.net' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.blocked, true);
  assert.equal(res.by, 'doubleclick.net');
});

test('FAIL-SAFE: adblock.explain 缺 host 被拒', async () => {
  const m = mod(fakeDnr());
  const h = m.handlers.find((x) => x.type === 'adblock.explain');
  for (const msg of [{}, { host: '' }, { host: 123 }]) {
    const res = await h.handle(msg, { config: { get: () => 'basic' } });
    assert.deepEqual(res, { ok: false, error: 'BAD_ARGS' });
  }
});

test('FAIL-SAFE: adblock.apply 成功后把档位写回配置', async () => {
  // 不写回的话：切到 strict → 刷新设置页又显示 basic。
  // 真实 Chrome 验收 T11b 抓到过这个缺口。
  const dnr = fakeDnr();
  const m = mod(dnr);
  const store = { mode: 'basic' };
  const ctx = {
    config: {
      get: () => store.mode,
      set: async (k, v) => {
        store[k] = v;
      },
    },
  };
  const h = m.handlers.find((x) => x.type === 'adblock.apply');
  await h.handle({ mode: 'strict' }, ctx);
  assert.equal(store.mode, 'strict');
});

test('FAIL-SAFE: 安装失败时不写回配置（避免配置与实际规则不一致）', async () => {
  const dnr = fakeDnr({ failUpdate: 'Invalid rule' });
  const m = mod(dnr);
  const store = { mode: 'basic' };
  const ctx = {
    config: {
      get: () => store.mode,
      set: async (k, v) => {
        store[k] = v;
      },
    },
  };
  const h = m.handlers.find((x) => x.type === 'adblock.apply');
  const res = await h.handle({ mode: 'strict' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(store.mode, 'basic', '安装失败却被记成 strict，配置就撒谎了');
});

test('PASS: adblock.status 首次调用时 mode 为 null', async () => {
  const m = mod(fakeDnr());
  const res = await m.handlers.find((h) => h.type === 'adblock.status').handle({}, {});
  assert.deepEqual(res, { ok: true, mode: null, lastError: null });
});

/* ============================ 规则集 id ============================ */

test('PASS: 规则集 id 是稳定字符串（改它会让已安装的规则失效）', () => {
  assert.equal(RULESET_ID, 'keynest_adblock');
});

/* ============================ 与 dNR 约束的一致性 ============================ */

test('FAIL-SAFE: 动态规则总数不超过浏览器上限（5000）', async () => {
  // Chrome 的 updateDynamicRules 硬上限是 5000 条。
  // 超过的表现是"安装失败"，而错误信息很难看懂。
  const dnr = fakeDnr();
  const m = mod(dnr);
  await m.applyRules('strict', Array.from({ length: 50 }, (_, i) => `site${i}.test`));
  assert.ok(
    dnr.state.installed.length <= 5000,
    `规则数 ${dnr.state.installed.length} 超过 Chrome 上限`
  );
});

test('FAIL-SAFE: 每条规则都有 id / priority / action / condition', async () => {
  const dnr = fakeDnr();
  await mod(dnr).applyRules('strict', ['a.test']);
  for (const r of dnr.state.installed) {
    assert.equal(typeof r.id, 'number', JSON.stringify(r));
    assert.equal(typeof r.priority, 'number');
    assert.ok(r.action && r.action.type);
    assert.ok(r.condition);
  }
});

/* ============================ 豁免名单接口 ============================ */

/**
 * 带配置记忆的 ctx。adblock 的豁免接口会读/写 `allowlist` 配置。
 *
 * 注意配置里存的是 **JSON 字符串**（配置中心只支持标量），
 * 这里如实模拟，否则测不出序列化相关的问题。
 */
function ctxWith(initial = {}) {
  const store = { mode: 'basic', allowlist: '[]', ...initial };
  return {
    store,
    config: {
      get: (k) => store[k],
      set: async (k, v) => {
        store[k] = v;
      },
    },
  };
}

test('PASS: adblock.allow 把域名写进配置并返回名单', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  const ctx = ctxWith();
  const h = m.handlers.find((x) => x.type === 'adblock.allow');

  const res = await h.handle({ domain: 'news.test' }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(res.list, ['news.test']);
  assert.equal(res.added, true);
  assert.deepEqual(JSON.parse(ctx.store.allowlist), ['news.test']);
});

test('PASS: 豁免后立即重装规则（不需要用户再点一次）', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  const ctx = ctxWith();
  const h = m.handlers.find((x) => x.type === 'adblock.allow');

  await h.handle({ domain: 'news.test' }, ctx);
  const allow = dnr.state.installed.find((r) => r.action.type === 'allowAllRequests');
  assert.ok(allow, '豁免规则没装上');
  assert.deepEqual(allow.condition.requestDomains, ['news.test']);
});

test('FAIL-SAFE: adblock.allow 拒绝非法域名', async () => {
  const m = mod(fakeDnr());
  const h = m.handlers.find((x) => x.type === 'adblock.allow');
  for (const domain of ['', 'not a domain', 'https://x.test/', '../etc', 123, null]) {
    const res = await h.handle({ domain }, ctxWith());
    assert.deepEqual(res, { ok: false, error: 'BAD_ARGS' }, String(domain));
  }
});

test('PASS: adblock.disallow 移除并重装', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  const ctx = ctxWith({ allowlist: '["news.test","other.test"]' });
  const h = m.handlers.find((x) => x.type === 'adblock.disallow');

  const res = await h.handle({ domain: 'news.test' }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(res.list, ['other.test']);
  assert.equal(res.removed, true);

  const allows = dnr.state.installed.filter((r) => r.action.type === 'allowAllRequests');
  assert.equal(allows.length, 1);
  assert.deepEqual(allows[0].condition.requestDomains, ['other.test']);
});

test('FAIL-SAFE: 配置里的坏 JSON 当空名单，不让功能整体失效', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  const ctx = ctxWith({ allowlist: '{坏掉的数据' });
  const h = m.handlers.find((x) => x.type === 'adblock.allowlist');
  const res = await h.handle({}, ctx);
  assert.deepEqual(res, { ok: true, list: [] });
});

test('FAIL-SAFE: 配置里混入非法域名时被清洗掉（否则 Chrome 拒整批规则）', async () => {
  const dnr = fakeDnr();
  const m = mod(dnr);
  const ctx = ctxWith({
    allowlist: JSON.stringify(['good.test', 'bad entry', 'https://x.test/', 'good.test']),
  });
  const h = m.handlers.find((x) => x.type === 'adblock.apply');
  const res = await h.handle({ mode: 'basic' }, ctx);

  assert.equal(res.ok, true);
  const allows = dnr.state.installed.filter((r) => r.action.type === 'allowAllRequests');
  assert.equal(allows.length, 1, '只有一条合法豁免');
  assert.deepEqual(allows[0].condition.requestDomains, ['good.test']);
});

test('PASS: adblock.check 判断当前站点是否已豁免', async () => {
  const m = mod(fakeDnr());
  const ctx = ctxWith({ allowlist: '["example.test"]' });
  const h = m.handlers.find((x) => x.type === 'adblock.check');

  const yes = await h.handle({ host: 'www.example.test' }, ctx);
  assert.equal(yes.allowed, true);
  assert.equal(yes.matched, 'example.test');

  const no = await h.handle({ host: 'notexample.test' }, ctx);
  assert.equal(no.allowed, false);
  assert.equal(no.matched, null);
});

test('FAIL-SAFE: adblock.check 拒绝非法 host', async () => {
  const m = mod(fakeDnr());
  const h = m.handlers.find((x) => x.type === 'adblock.check');
  for (const host of ['', 123, null, 'a b']) {
    assert.deepEqual(await h.handle({ host }, ctxWith()), { ok: false, error: 'BAD_ARGS' });
  }
});

test('PASS: adblock.allowlist 返回当前名单', async () => {
  const m = mod(fakeDnr());
  const ctx = ctxWith({ allowlist: '["b.test","a.test"]' });
  const h = m.handlers.find((x) => x.type === 'adblock.allowlist');
  assert.deepEqual((await h.handle({}, ctx)).list, ['b.test', 'a.test']);
});
