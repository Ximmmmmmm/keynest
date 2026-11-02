// 并发兑换与 frame 绑定的自动化测试。
//
// 这是阶段 2.3 的核心：**不是顺序调用两次，而是真并发 100 个请求**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../lib/auth-store.js';
import { redeemFill } from '../lib/redeem.js';

const TTL = 5000;
const ORIGIN = 'https://example.com';

function makeAuths(startAt = 0) {
  let t = startAt;
  const auths = new AuthStore(() => t, TTL);
  return { auths, tick: (ms) => { t += ms; } };
}

const BIND = { tabId: 7, frameId: 0, origin: ORIGIN, entryId: 'e1', username: 'u' };

function claimOf(over = {}) {
  return { tabId: BIND.tabId, frameId: BIND.frameId, origin: BIND.origin, entryId: BIND.entryId, ...over };
}

/** 可观测的依赖实现：统计每个 API 被调用了几次。 */
function makeDeps(opts = {}) {
  const calls = { getFrame: 0, getTab: 0, fill: 0 };
  const delay = opts.delay ?? 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    calls,
    deps: {
      getFrame: async () => {
        calls.getFrame += 1;
        if (delay) await sleep(delay);
        if (opts.frameThrows) throw new Error('frame gone');
        return { url: opts.frameUrl ?? `${ORIGIN}/login` };
      },
      getTab: async () => {
        calls.getTab += 1;
        if (delay) await sleep(delay);
        if (opts.tabThrows) throw new Error('tab gone');
        return { url: opts.tabUrl ?? `${ORIGIN}/login` };
      },
      fill: async () => {
        calls.fill += 1;
        if (delay) await sleep(delay);
        if (opts.fillThrows) throw new Error('FILL_FAILED');
        return { password: 'test-password' };
      },
    },
  };
}

/* ============================ 并发兑换 ============================ */

test('PASS: 100 个并发请求只有 1 个成功，密码只读一次', async () => {
  const { auths } = makeAuths();
  auths.issue('n1', BIND);
  const { deps, calls } = makeDeps({ delay: 5 });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'n1', claimOf()))
  );

  const ok = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);

  assert.equal(ok.length, 1, '只允许一个成功');
  assert.equal(rejected.length, 99, '其余全部拒绝');
  assert.equal(calls.fill, 1, '密码只能读取一次');
  assert.equal(calls.getFrame, 1, 'frame 校验只发生一次（认领在 await 之前）');
  assert.equal(calls.getTab, 1, 'tab 校验只发生一次');
  assert.equal(auths.size(), 0, '成功后记录应被消费');
});

test('PASS: 100 并发 + tabs.get 延迟 50ms 仍只成功一次', async () => {
  const { auths } = makeAuths();
  auths.issue('n2', BIND);
  const { deps, calls } = makeDeps({ delay: 50 });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'n2', claimOf()))
  );

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(calls.fill, 1);
});

test('PASS: 100 并发 + fill 延迟 50ms 仍只成功一次', async () => {
  const { auths } = makeAuths();
  auths.issue('n3', BIND);
  const { deps, calls } = makeDeps({ delay: 50 });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'n3', claimOf()))
  );

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(calls.fill, 1, '即使 fill 很慢，也只能有一次');
});

test('PASS: 并发中 tabs.get 失败 → 全部拒绝，密码零读取', async () => {
  const { auths } = makeAuths();
  auths.issue('n4', BIND);
  const { deps, calls } = makeDeps({ tabThrows: true });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'n4', claimOf()))
  );

  assert.equal(results.filter((r) => r.ok).length, 0);
  assert.equal(calls.fill, 0, '校验失败绝不能读密码');
  assert.equal(auths.size(), 0, '失败必须销毁记录');
});

test('PASS: 并发中 getFrame 失败 → 全部拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('n5', BIND);
  const { deps, calls } = makeDeps({ frameThrows: true });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'n5', claimOf()))
  );

  assert.equal(results.filter((r) => r.ok).length, 0);
  assert.equal(calls.fill, 0);
});

test('PASS: 请求中途断连（fill 抛错）→ 记录销毁，不可重试', async () => {
  const { auths } = makeAuths();
  auths.issue('n6', BIND);
  const { deps } = makeDeps({ fillThrows: true });

  const r = await redeemFill(auths, deps, 'n6', claimOf());
  assert.equal(r.ok, false);
  assert.equal(auths.size(), 0, '断连后记录必须销毁');

  // 再试一次也必须失败
  const r2 = await redeemFill(auths, makeDeps().deps, 'n6', claimOf());
  assert.equal(r2.ok, false, '销毁后不可重试');
});

test('PASS: 认领后超时（confirm 前记录被清）→ 拒绝且不读密码', async () => {
  const { auths } = makeAuths();
  auths.issue('n7', BIND);

  // 手动模拟：认领后立刻被外部清空（等价于导航/tab关闭/断连）
  const rec = auths.claim('n7', claimOf());
  assert.ok(rec);
  auths.clear();

  const { deps, calls } = makeDeps();
  const r = await redeemFill(auths, deps, 'n7', claimOf());
  assert.equal(r.ok, false);
  assert.equal(calls.fill, 0);
});

/* ============================ frame 绑定 ============================ */

test('PASS: 主 frame，frame URL 与授权 origin 一致 → 通过', async () => {
  const { auths } = makeAuths();
  auths.issue('f1', BIND);
  const { deps } = makeDeps({ frameUrl: `${ORIGIN}/login` });
  const r = await redeemFill(auths, deps, 'f1', claimOf());
  assert.equal(r.ok, true);
});

test('FAIL-guard: 跨 origin iframe → 拒绝（frame URL 不符）', async () => {
  const { auths } = makeAuths();
  auths.issue('f2', BIND);
  // 顶层是 example.com，但真实 frame 是 evil.test
  const { deps, calls } = makeDeps({
    tabUrl: `${ORIGIN}/page`,
    frameUrl: 'https://evil.test/login',
  });
  const r = await redeemFill(auths, deps, 'f2', claimOf());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FRAME_ORIGIN_MISMATCH');
  assert.equal(calls.fill, 0, 'frame origin 不符绝不能读密码');
});

test('FAIL-guard: 子域 iframe → 拒绝（不自动信任子域）', async () => {
  const { auths } = makeAuths();
  auths.issue('f3', BIND);
  const { deps } = makeDeps({ frameUrl: 'https://sub.example.com/login' });
  const r = await redeemFill(auths, deps, 'f3', claimOf());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FRAME_ORIGIN_MISMATCH');
});

test('FAIL-guard: 同域不同端口 → 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('f4', BIND);
  const { deps } = makeDeps({ frameUrl: 'https://example.com:8443/login' });
  const r = await redeemFill(auths, deps, 'f4', claimOf());
  assert.equal(r.ok, false);
});

test('FAIL-guard: frameId 不匹配 → 认领阶段就拒绝，不调任何浏览器 API', async () => {
  const { auths } = makeAuths();
  auths.issue('f5', { ...BIND, frameId: 3 });
  const { deps, calls } = makeDeps();
  const r = await redeemFill(auths, deps, 'f5', claimOf({ frameId: 0 }));
  assert.equal(r.ok, false);
  assert.equal(calls.getFrame, 0, '绑定不符时不应发起浏览器调用');
  assert.equal(calls.fill, 0);
});

test('FAIL-guard: 顶层页面导航到别的 origin，但 frame 仍是授权 origin', async () => {
  // 这是一个真实场景：iframe 里是登录页，顶层被导航到攻击者页面。
  // 当前实现：frameOrigin 校验通过，但顶层已变——需要额外判断。
  const { auths } = makeAuths();
  auths.issue('f6', BIND);
  const { deps } = makeDeps({
    tabUrl: 'https://attacker.test/page',
    frameUrl: `${ORIGIN}/login`,
  });
  const r = await redeemFill(auths, deps, 'f6', claimOf());
  // 顶层 origin 与授权 origin 不同，但 frame 相同。
  // 结论：应当拒绝（顶层已被换掉说明页面状态不可信）。
  assert.equal(r.ok, false, '顶层 origin 变化时必须拒绝');
});

test('PASS: iframe 导航后旧授权失效（frameId 变化被绑定校验挡住）', async () => {
  const { auths } = makeAuths();
  auths.issue('f7', { ...BIND, frameId: 5 });
  const { deps } = makeDeps({ frameUrl: `${ORIGIN}/login` });
  const r = await redeemFill(auths, deps, 'f7', claimOf({ frameId: 9 }));
  assert.equal(r.ok, false);
});

test('PASS: frame 被销毁（getFrame 抛错）→ 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('f8', BIND);
  const { deps } = makeDeps({ frameThrows: true });
  const r = await redeemFill(auths, deps, 'f8', claimOf());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FRAME_GONE');
});

test('PASS: getFrame 返回无 url → 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('f9', BIND);
  const { deps } = makeDeps({ frameUrl: undefined });
  // 构造返回 {} 的情况
  const d = { ...deps, getFrame: async () => ({}) };
  const r = await redeemFill(auths, d, 'f9', claimOf());
  assert.equal(r.ok, false);
});

/* ============================ 状态机不变量 ============================ */

test('PASS: claim 是同步的（返回记录而非 Promise）', () => {
  const { auths } = makeAuths();
  auths.issue('s1', BIND);
  const r = auths.claim('s1', claimOf());
  assert.ok(r, 'claim 必须同步返回记录');
  assert.equal(typeof r.then, 'undefined', 'claim 不能是异步');
  assert.equal(r.state, 'validating');
});

test('PASS: validating 不可回退到 issued', () => {
  const { auths } = makeAuths();
  auths.issue('s2', BIND);
  auths.claim('s2', claimOf());
  assert.equal(auths.claim('s2', claimOf()), null, '再次 claim 必须失败');
  // 记录**保留**在 validating：并发时第 2..N 个请求不该毁掉第一个请求的认领
  assert.equal(auths.size(), 1, '并发失败不应销毁记录');
  assert.equal(auths.countByState('validating'), 1);
});

test('PASS: 并发失败保留记录，攻击性绑定不符才销毁', () => {
  const { auths } = makeAuths();
  auths.issue('s5', BIND);

  // 并发：同一个绑定值第二次 claim → 失败但保留
  auths.claim('s5', claimOf());
  assert.equal(auths.claim('s5', claimOf()), null);
  assert.equal(auths.size(), 1, '并发不应销毁');

  // 此时记录归第一个请求所有。攻击者用错误绑定再来试：
  // 仍然拿不到东西，且**不该**销毁记录——否则攻击者可以用乱试
  // 把合法请求的授权打掉（DoS）。
  assert.equal(auths.claim('s5', claimOf({ tabId: 999 })), null);
  assert.equal(auths.size(), 1, '已认领后乱试不应销毁（防 DoS）');
});

test('PASS: issued 状态下绑定不符 → 立即销毁（防重试）', () => {
  const { auths } = makeAuths();
  auths.issue('s6', BIND);
  // 记录还是 issued，攻击者拿错绑定来试 → 销毁
  assert.equal(auths.claim('s6', claimOf({ tabId: 999 })), null);
  assert.equal(auths.size(), 0, 'issued 状态下的绑定不符必须销毁');
  // 之后合法请求也无法再用
  assert.equal(auths.claim('s6', claimOf()), null);
});

test('PASS: confirm 只接受 validating 状态', () => {
  const { auths } = makeAuths();
  auths.issue('s3', BIND);
  assert.equal(auths.confirm('s3'), null, 'issued 状态不能直接 confirm');
});

test('PASS: 状态计数正确', () => {
  const { auths } = makeAuths();
  auths.issue('s4', BIND);
  assert.equal(auths.countByState('issued'), 1);
  auths.claim('s4', claimOf());
  assert.equal(auths.countByState('issued'), 0);
  assert.equal(auths.countByState('validating'), 1);
});
