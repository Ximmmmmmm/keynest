// 域名匹配与规则引擎的测试。
//
// 这个文件里 **失败路径比成功路径多**，原因很直接：
// 域名匹配写错的表现是「拦了不该拦的」，而这类错误只测正例永远发现不了。

import test from 'node:test';
import assert from 'node:assert/strict';

import { belongsTo, hostOf, matchesAny, normalizeDomain } from '../lib/filters/domain.js';
import {
  AD_HOSTS,
  MODES,
  RULE_ID_BASE,
  STRICT_HOSTS,
  TRACKING_PARAMS,
  buildBlockRules,
  buildParamStripRules,
  buildPathBlockRules,
  buildRuleset,
  countBlocked,
  explainHost,
} from '../lib/filters/rules.js';

/* ============================ 域名规范化 ============================ */

test('PASS: 大小写与首尾点被规范化', () => {
  assert.equal(normalizeDomain('EVIL.COM'), 'evil.com');
  assert.equal(normalizeDomain('evil.com.'), 'evil.com');
  assert.equal(normalizeDomain('.evil.com'), 'evil.com');
  assert.equal(normalizeDomain('  evil.com  '), 'evil.com');
  assert.equal(normalizeDomain('evil.com:8080'), 'evil.com');
});

test('FAIL-SAFE: 坏域名返回 null 而不是猜', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}, 'evil..com', 'a/b', '[::1]', 'x'.repeat(300)]) {
    assert.equal(normalizeDomain(bad), null, String(bad));
  }
});

test('FAIL-SAFE: 超长标签被拒绝（RFC 限制 63）', () => {
  assert.equal(normalizeDomain('a'.repeat(64) + '.com'), null);
  assert.equal(normalizeDomain('a'.repeat(63) + '.com'), 'a'.repeat(63) + '.com');
});

/* ============================ 归属判断 ============================ */

test('PASS: 自身与子域都算归属', () => {
  assert.equal(belongsTo('evil.com', 'evil.com'), true);
  assert.equal(belongsTo('a.evil.com', 'evil.com'), true);
  assert.equal(belongsTo('a.b.c.evil.com', 'evil.com'), true);
});

test('FAIL-SAFE: 标签边界 —— notevil.com 不属于 evil.com', () => {
  // 这就是「必须补前导点再比后缀」的理由。
  // 写成 host.endsWith(domain) 会在这里返回 true。
  assert.equal(belongsTo('notevil.com', 'evil.com'), false);
  assert.equal(belongsTo('myevil.com', 'evil.com'), false);
  assert.equal(belongsTo('evil.com.evil.test', 'evil.com'), false);
  assert.equal(belongsTo('evil.company', 'evil.com'), false);
});

test('FAIL-SAFE: 大小写与尾点不能绕过', () => {
  assert.equal(belongsTo('A.EVIL.COM', 'evil.com'), true);
  assert.equal(belongsTo('a.evil.com.', 'evil.com'), true);
  assert.equal(belongsTo('notevil.com.', 'evil.com'), false);
  assert.equal(belongsTo('a.evil.com:443', 'evil.com'), true);
});

test('FAIL-SAFE: 空值不匹配任何东西', () => {
  assert.equal(belongsTo('', 'evil.com'), false);
  assert.equal(belongsTo('evil.com', ''), false);
  assert.equal(belongsTo(null, 'evil.com'), false);
  assert.equal(belongsTo('evil.com', null), false);
});

test('PASS: matchesAny 逐个试', () => {
  const list = ['a.test', 'b.test'];
  assert.equal(matchesAny('x.a.test', list), true);
  assert.equal(matchesAny('b.test', list), true);
  assert.equal(matchesAny('c.test', list), false);
  assert.equal(matchesAny('xa.test', list), false);
});

/* ============================ URL → host ============================ */

test('PASS: 从 URL 取 host', () => {
  assert.equal(hostOf('https://a.evil.com/path?q=1'), 'a.evil.com');
  assert.equal(hostOf('http://EVIL.com:8080/'), 'evil.com');
});

test('FAIL-SAFE: 非 http(s) 协议一律 null', () => {
  for (const u of [
    'file:///etc/passwd',
    'data:text/html,x',
    'javascript:alert(1)',
    'chrome-extension://abc/x.html',
    'ftp://evil.com/',
    'about:blank',
    '',
    'not a url',
    null,
  ]) {
    assert.equal(hostOf(u), null, String(u));
  }
});

test('FAIL-SAFE: userinfo 不能伪装 host', () => {
  // https://evil.com@good.test/ 的真实 host 是 good.test
  assert.equal(hostOf('https://evil.com@good.test/'), 'good.test');
});

/* ============================ 规则构造 ============================ */

test('PASS: block 规则用 requestDomains 而非子串 urlFilter', () => {
  const rules = buildBlockRules(['evil.com']);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.requestDomains, ['evil.com']);
  assert.equal(rules[0].condition.urlFilter, undefined, '不能用子串匹配');
  assert.equal(rules[0].action.type, 'block');
});

test('FAIL-SAFE: 带路径的条目进不了 buildBlockRules', () => {
  // yandex.ru/metrika 不是纯域名，混进 requestDomains 会写出无效规则
  assert.equal(buildBlockRules(['yandex.ru/metrika']).length, 0);
});

test('PASS: 带路径的条目用 ||domain^path 语法', () => {
  const rules = buildPathBlockRules(['yandex.ru/metrika']);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, '||yandex.ru^metrika');
});

test('FAIL-SAFE: 路径里的特殊字符被拒绝（防止拼出意外规则）', () => {
  const bad = ['evil.com/a b', 'evil.com/a|b', 'evil.com/a*b', 'evil.com/'];
  for (const entry of bad) {
    assert.equal(buildPathBlockRules([entry]).length, 0, entry);
  }
});

test('FAIL-SAFE: 参数名形状不对的规则被跳过', () => {
  const rules = buildParamStripRules(['ok_param', 'bad param', 'bad/path', '']);
  assert.equal(rules.length, 1);
  assert.deepEqual(
    rules[0].action.redirect.transform.queryTransform.removeParams,
    ['ok_param']
  );
});

test('PASS: 参数剔除规则只作用于第三方请求', () => {
  const [rule] = buildParamStripRules(['utm_source']);
  // 字段名必须是 domainType:'thirdParty'，不能是 thirdParty:true。
  // Chrome 的 dNR 会以 "Unexpected property: 'thirdParty'" 拒绝整批规则——
  // 这个错误假 dNR 测不出来，只有真实浏览器才会暴露。
  assert.equal(rule.condition.domainType, 'thirdParty', '第一方请求不能改，会影响签名校验');
  assert.equal('thirdParty' in rule.condition, false, 'domainType 才是正确字段名');
});

/* ============================ 档位 ============================ */

test('FAIL-SAFE: off 档返回空规则集（不是"有规则但不装"）', () => {
  const r = buildRuleset('off');
  assert.deepEqual(r.block, []);
  assert.deepEqual(r.redirect, []);
});

test('FAIL-SAFE: 未知档位抛错而不是静默降级', () => {
  assert.throws(() => buildRuleset('paranoid'));
  assert.throws(() => buildRuleset(undefined));
});

test('PASS: basic 只拦广告域，不含 strict 专属', () => {
  const basic = buildRuleset('basic');
  const strict = buildRuleset('strict');
  assert.ok(basic.block.length > 0);
  assert.equal(basic.redirect.length, 0, 'basic 不改写 URL');
  assert.ok(strict.block.length > basic.block.length, 'strict 应该更多');
  assert.ok(strict.redirect.length > 0, 'strict 才剔参数');
});

test('FAIL-SAFE: 规则 id 全局唯一（重复会让整批安装失败）', () => {
  for (const mode of ['basic', 'strict']) {
    const r = buildRuleset(mode);
    const all = [...r.block, ...r.redirect];
    const ids = new Set(all.map((x) => x.id));
    assert.equal(ids.size, all.length, `${mode}: id 有重复`);
    // 且都大于等于基准值
    for (const id of ids) assert.ok(id >= RULE_ID_BASE);
  }
});

test('FAIL-SAFE: 规则 id 在两个档位间是稳定的（basic 的 id 在 strict 里不变）', () => {
  // 不稳定会导致切档位时全量重装，且 diff 无法比较
  const basic = buildRuleset('basic');
  const strict = buildRuleset('strict');
  const strictById = new Map(strict.block.map((r) => [r.id, r]));
  for (const rule of basic.block) {
    const same = strictById.get(rule.id);
    assert.ok(same, `basic 的规则 ${rule.id} 在 strict 里消失了`);
    assert.deepEqual(same.condition, rule.condition);
  }
});

test('FAIL-SAFE: 绝不生成 allowAllRequests 之类的放行规则', () => {
  for (const mode of MODES) {
    const r = buildRuleset(mode);
    for (const rule of [...r.block, ...r.redirect]) {
      assert.notEqual(rule.action.type, 'allow');
      assert.notEqual(rule.action.type, 'allowAllRequests');
    }
  }
});

/* ============================ 拦截解释 ============================ */

test('PASS: explainHost 指出是哪条规则拦的', () => {
  assert.deepEqual(explainHost('ad.doubleclick.net', 'basic'), {
    blocked: true,
    by: 'doubleclick.net',
  });
  assert.deepEqual(explainHost('sub.doubleclick.net', 'basic'), {
    blocked: true,
    by: 'doubleclick.net',
  });
});

test('FAIL-SAFE: 相似域名不被误拦', () => {
  for (const host of ['notdoubleclick.net', 'doubleclick.net.evil.test', 'mydoubleclick.net']) {
    assert.equal(explainHost(host, 'basic').blocked, false, host);
  }
});

test('FAIL-SAFE: 主域绝不进清单（否则会把搜索/登录一起拦掉）', () => {
  // 这是一条硬约束：清单里不能出现 google.com、facebook.com 这类主域
  const HIGH_RISK = ['google.com', 'facebook.com', 'twitter.com', 'linkedin.com', 'yandex.ru'];
  for (const main of HIGH_RISK) {
    assert.equal(
      AD_HOSTS.includes(main),
      false,
      `${main} 不能进 AD_HOSTS——它的子域做广告，但主域是正经服务`
    );
    // strict 也不许
    assert.equal(STRICT_HOSTS.includes(main), false, `${main} 不能进 STRICT_HOSTS`);
  }
});

test('PASS: off 档下什么都不拦', () => {
  assert.deepEqual(explainHost('doubleclick.net', 'off'), { blocked: false, by: null });
});

test('PASS: strict 比 basic 多拦', () => {
  assert.equal(explainHost('connect.facebook.net', 'basic').blocked, false);
  assert.equal(explainHost('connect.facebook.net', 'strict').blocked, true);
});

test('PASS: countBlocked 统计', () => {
  const urls = [
    'https://doubleclick.net/x.js',
    'https://example.test/app.js',
    'https://sub.googlesyndication.com/a.png',
    'not-a-url',
  ];
  assert.deepEqual(countBlocked(urls, 'basic'), { total: 4, blocked: 2 });
  assert.deepEqual(countBlocked(urls, 'off'), { total: 4, blocked: 0 });
});

/* ============================ 清单自身健康度 ============================ */

test('PASS: 清单里没有重复项', () => {
  for (const [name, list] of [
    ['AD_HOSTS', AD_HOSTS],
    ['STRICT_HOSTS', STRICT_HOSTS],
    ['TRACKING_PARAMS', TRACKING_PARAMS],
  ]) {
    assert.equal(new Set(list).size, list.length, `${name} 有重复`);
  }
});

test('PASS: 清单全部是小写（大小写混写会让 requestDomains 匹配不上）', () => {
  for (const list of [AD_HOSTS, STRICT_HOSTS]) {
    for (const d of list) {
      assert.equal(d, d.toLowerCase(), d);
    }
  }
});

test('PASS: 清单项要么是合法域名、要么是 domain/path 形式', () => {
  for (const d of [...AD_HOSTS, ...STRICT_HOSTS]) {
    if (d.includes('/')) {
      const [dom] = d.split('/');
      assert.ok(normalizeDomain(dom), `${d} 的域名部分不合法`);
    } else {
      assert.ok(normalizeDomain(d), `${d} 不是合法域名`);
    }
  }
});
