// TTL 单调时钟与边界测试。
//
// 核心：**不依赖真实等待 5 秒**，全部用可注入时钟驱动。
// AuthStore 的 `now` 本来就是构造函数注入的，直接复用，不扩大架构。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../lib/auth-store.js';

const TTL = 5000;

const BIND = {
  tabId: 7,
  frameId: 0,
  origin: 'https://example.com',
  entryId: 'e1',
  username: 'u',
  documentId: 'doc-a',
  topDocumentId: 'doc-a',
};

function claimOf(over = {}) {
  return {
    tabId: BIND.tabId,
    frameId: BIND.frameId,
    origin: BIND.origin,
    entryId: BIND.entryId,
    ...over,
  };
}

/** 可控时钟：手动推进。 */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    set: (v) => { t = v; },
    advance: (ms) => { t += ms; },
  };
}

/* ------------------------- TTL 边界 ------------------------- */

test('PASS: 4.9 秒仍在有效期内', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n1', BIND);
  c.advance(4900);
  const r = auths.claim('n1', claimOf());
  assert.ok(r, '4.9s 必须仍可兑换');
  assert.equal(r.state, 'validating');
});

test('PASS: 恰好 5.0 秒按既定语义拒绝（<= 即过期）', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n2', BIND);
  c.advance(5000);
  assert.equal(auths.claim('n2', claimOf()), null, '5.0s 边界必须失效');
  assert.equal(auths.size(), 0, '过期记录必须被清理');
});

test('PASS: 5.1 秒拒绝', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n3', BIND);
  c.advance(5100);
  assert.equal(auths.claim('n3', claimOf()), null);
});

test('PASS: 4.999 秒仍有效（边界内侧）', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n4', BIND);
  c.advance(4999);
  assert.ok(auths.claim('n4', claimOf()));
});

/* --------------------- 墙上时钟调整不影响 --------------------- */

test('PASS: 墙上时钟后拨 10 分钟不能延长授权（单调时钟不受影响）', () => {
  // 单调时钟只走 4.9s；墙上时钟即使跳 +600s 也与这里无关
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n5', BIND);
  c.advance(4900); // 单调 4.9s
  const wallJump = 600_000; // 模拟墙上时钟被后拨 10 分钟（不影响单调时钟）
  assert.ok(wallJump > 0); // 仅作为注释性断言，证明场景成立
  assert.ok(auths.claim('n5', claimOf()), '单调时钟未到 5s，仍应有效');
});

test('PASS: 单调时钟走满 5s 时，即使墙上时钟前拨也必须拒绝', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n6', BIND);
  c.advance(5000); // 单调 5s
  assert.equal(auths.claim('n6', claimOf()), null, '单调时钟决定 TTL，墙上时钟无关');
});

test('PASS: 墙上时钟回拨 10 分钟不会让已过期授权复活', () => {
  // 关键场景：若用 Date.now()，回拨会让 now 变小 → 过期判断失效。
  // 用单调时钟时，单调值只会单调增，回拨没有影响。
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n7', BIND);
  c.advance(6000); // 单调已过期
  assert.equal(auths.claim('n7', claimOf()), null);
  // 再"回拨"墙上时间（这里单调时钟不回落，只证明语义）
  c.set(0);
  assert.equal(auths.claim('n7', claimOf()), null, '记录已删，回拨无法复活');
});

/* ------------------------ 时间源异常 ------------------------ */

test('PASS: 时钟返回 NaN 时拒绝签发（不会产生永不过期的授权）', () => {
  const auths = new AuthStore(() => Number.NaN, TTL);
  assert.throws(() => auths.issue('n8', BIND), /clock unavailable/);
  assert.equal(auths.size(), 0, '异常时钟不应留下任何记录');
});

test('PASS: 时钟返回 Infinity 时拒绝签发', () => {
  const auths = new AuthStore(() => Number.POSITIVE_INFINITY, TTL);
  assert.throws(() => auths.issue('n9', BIND), /clock unavailable/);
});

test('PASS: 时钟中途变成 NaN 时视为已过期（保守拒绝）', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n10', BIND);
  c.set(Number.NaN); // 时钟异常
  assert.equal(auths.claim('n10', claimOf()), null, '异常时钟必须拒绝，不能放行');
  assert.equal(auths.size(), 0);
});

test('PASS: 时钟抛异常时视为已过期', () => {
  let throwNext = false;
  const auths = new AuthStore(() => {
    if (throwNext) throw new Error('boom');
    return 0;
  }, TTL);
  auths.issue('n11', BIND);
  throwNext = true;
  assert.equal(auths.claim('n11', claimOf()), null);
});

/* ------------------------ 一次性语义 ------------------------ */

test('PASS: 多次兑换仍只能成功一次', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n12', BIND);
  assert.ok(auths.claim('n12', claimOf()));
  assert.equal(auths.claim('n12', claimOf()), null, '第二次必须失败');
  assert.equal(auths.claim('n12', claimOf()), null, '第三次也必须失败');
});

test('PASS: 100 并发仍只成功一次（单调时钟下）', async () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n13', BIND);
  const results = await Promise.all(
    Array.from({ length: 100 }, async () => auths.claim('n13', claimOf()))
  );
  assert.equal(results.filter(Boolean).length, 1);
});

/* ------------------------ SW 重启语义 ------------------------ */

test('PASS: 新实例（模拟 SW 重启）不能恢复旧授权', () => {
  const c = makeClock();
  const oldStore = new AuthStore(c.now, TTL);
  oldStore.issue('n14', BIND);
  // SW 重启：全新实例，内存为空；performance.now() 也归零
  const fresh = new AuthStore(makeClock(0).now, TTL);
  assert.equal(fresh.claim('n14', claimOf()), null);
  assert.equal(fresh.size(), 0);
});

test('PASS: 重启后即使单调时钟归零也不会误判为有效', () => {
  // performance.now() 重启后从 0 开始，而旧记录的 expiresAt 是基于旧上下文的大数值。
  // 但旧记录在新实例里根本不存在，所以不存在"归零导致误判"的问题。
  const old = new AuthStore(makeClock(100_000).now, TTL);
  old.issue('n15', BIND);
  const fresh = new AuthStore(makeClock(0).now, TTL);
  assert.equal(fresh.peek('n15'), null, '新实例看不到旧记录');
  assert.equal(fresh.claim('n15', claimOf()), null);
});

/* --------------------- confirm 阶段的过期 --------------------- */

test('PASS: 认领后、confirm 前过期则拒绝（不取密码）', () => {
  const c = makeClock();
  const auths = new AuthStore(c.now, TTL);
  auths.issue('n16', BIND);
  assert.ok(auths.claim('n16', claimOf()));
  c.advance(6000); // 认领之后才过期
  assert.equal(auths.confirm('n16'), null, 'confirm 必须复查过期');
  assert.equal(auths.size(), 0);
});
