// 授权状态机的自动化测试。
//
// 覆盖：正常流程、拒绝流程、重放、并发、过期、导航、tab 关闭、SW 重启。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../lib/auth-store.js';

const TTL = 5000;

function makeStore(startAt = 0) {
  let t = startAt;
  const store = new AuthStore(() => t, TTL);
  return { store, tick: (ms) => { t += ms; } };
}

const BIND = {
  tabId: 7,
  frameId: 0,
  origin: 'https://example.com',
  entryId: 'e1',
  username: 'u',
};

function claim(over = {}) {
  return {
    tabId: BIND.tabId,
    frameId: BIND.frameId,
    origin: BIND.origin,
    entryId: BIND.entryId,
    ...over,
  };
}

/* ----------------------------- 正常流程 ----------------------------- */

test('PASS: 正常签发 → 兑换 → 消费', () => {
  const { store } = makeStore();
  store.issue('n1', BIND);
  const rec = store.beginRedeem('n1', claim());
  assert.ok(rec, '第一次兑换必须成功');
  assert.equal(rec.state, 'consuming');
  store.consume('n1');
  assert.equal(store.size(), 0, '消费后不应残留');
});

test('PASS: 兑换后状态从 issued 变为 consuming', () => {
  const { store } = makeStore();
  store.issue('n2', BIND);
  assert.equal(store.peek('n2').state, 'issued');
  store.beginRedeem('n2', claim());
  assert.equal(store.peek('n2').state, 'consuming');
});

/* ----------------------------- 拒绝流程 ----------------------------- */

test('PASS: 不存在的 nonce 被拒绝', () => {
  const { store } = makeStore();
  assert.equal(store.beginRedeem('nope', claim()), null);
});

test('PASS: 令牌重复使用被拒绝（重放）', () => {
  const { store } = makeStore();
  store.issue('n3', BIND);
  assert.ok(store.beginRedeem('n3', claim()));
  // 第二次：状态已是 consuming
  assert.equal(store.beginRedeem('n3', claim()), null, '重放必须失败');
});

test('PASS: 并发重放只成功一次', () => {
  const { store } = makeStore();
  store.issue('n4', BIND);
  const r1 = store.beginRedeem('n4', claim());
  const r2 = store.beginRedeem('n4', claim());
  assert.ok(r1, '第一个必须成功');
  assert.equal(r2, null, '第二个必须失败');
});

test('PASS: 过期令牌被拒绝', () => {
  const { store, tick } = makeStore();
  store.issue('n5', BIND);
  tick(TTL + 1);
  assert.equal(store.beginRedeem('n5', claim()), null);
  assert.equal(store.size(), 0, '过期项应被清理');
});

test('PASS: tab 不匹配被拒绝', () => {
  const { store } = makeStore();
  store.issue('n6', BIND);
  assert.equal(store.beginRedeem('n6', claim({ tabId: 99 })), null);
});

test('PASS: frame 不匹配被拒绝', () => {
  const { store } = makeStore();
  store.issue('n7', BIND);
  assert.equal(store.beginRedeem('n7', claim({ frameId: 3 })), null);
});

test('PASS: origin 不匹配被拒绝', () => {
  const { store } = makeStore();
  store.issue('n8', BIND);
  assert.equal(
    store.beginRedeem('n8', claim({ origin: 'https://example.com.evil.test' })),
    null
  );
});

test('PASS: entryId 不匹配被拒绝', () => {
  const { store } = makeStore();
  store.issue('n9', BIND);
  assert.equal(store.beginRedeem('n9', claim({ entryId: 'e2' })), null);
});

test('PASS: 校验失败后记录被删除（不留重试机会）', () => {
  const { store } = makeStore();
  store.issue('n10', BIND);
  store.beginRedeem('n10', claim({ tabId: 99 }));
  assert.equal(store.size(), 0, '失败必须删除，不能留着重试');
});

/* --------------------------- 生命周期失效 --------------------------- */

test('PASS: 主框架导航后授权失效', () => {
  const { store } = makeStore();
  store.issue('n11', BIND);
  store.invalidateNavigation(BIND.tabId, 0);
  assert.equal(store.beginRedeem('n11', claim()), null);
});

test('PASS: 子框架导航不影响主框架授权', () => {
  const { store } = makeStore();
  store.issue('n12', BIND);
  store.invalidateNavigation(BIND.tabId, 5); // 非主框架
  assert.ok(store.beginRedeem('n12', claim()), '子帧导航不应作废主帧授权');
});

test('PASS: tab 关闭后授权失效', () => {
  const { store } = makeStore();
  store.issue('n13', BIND);
  store.invalidateTab(BIND.tabId);
  assert.equal(store.beginRedeem('n13', claim()), null);
});

test('PASS: 只失效指定 tab 的授权', () => {
  const { store } = makeStore();
  store.issue('n14', { ...BIND, tabId: 1 });
  store.issue('n15', { ...BIND, tabId: 2 });
  store.invalidateTab(1);
  assert.equal(store.beginRedeem('n14', { ...claim(), tabId: 1 }), null);
  assert.ok(store.beginRedeem('n15', { ...claim(), tabId: 2 }), '别的 tab 不受影响');
});

test('PASS: SW 重启（新实例）不能恢复旧授权', () => {
  const { store: oldStore } = makeStore();
  oldStore.issue('n16', BIND);
  // 模拟 SW 重启：全新实例，内存为空
  const { store: fresh } = makeStore();
  assert.equal(fresh.beginRedeem('n16', claim()), null, '新实例不应认得旧 nonce');
  assert.equal(fresh.size(), 0);
});

test('PASS: clear() 让所有授权立即失效（断连/锁定）', () => {
  const { store } = makeStore();
  store.issue('n17', BIND);
  store.issue('n18', BIND);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.beginRedeem('n17', claim()), null);
});

/* ----------------------------- 边界 ----------------------------- */

test('PASS: 空 nonce 拒绝签发', () => {
  const { store } = makeStore();
  assert.throws(() => store.issue('', BIND));
});

test('PASS: nonce 冲突拒绝（CSPRNG 碰撞保护）', () => {
  const { store } = makeStore();
  store.issue('dup', BIND);
  assert.throws(() => store.issue('dup', BIND));
});

test('PASS: sweep 清理过期项并返回数量', () => {
  const { store, tick } = makeStore();
  store.issue('a', BIND);
  store.issue('b', BIND);
  tick(TTL + 1);
  assert.equal(store.sweep(), 2);
});
