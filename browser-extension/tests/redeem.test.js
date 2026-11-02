// 兑换流程测试：origin 来源、documentId 绑定、并发、frame 身份。
//
// 关键前提：**真实 Chrome 无 host 权限时 tabs.get 不返回 url**，
// 所以依赖形状里根本没有 getTab——origin 只能来自 getFrame。
// 如果哪天有人把 getTab 加回来并用于 origin 判断，这组测试的 mock 会立刻暴露它。

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../lib/auth-store.js';
import { redeemFill, resolveFrame } from '../lib/redeem.js';

const TTL = 5000;
const ORIGIN = 'https://example.com';
const DOC = 'doc-main-1';
const TOPDOC = 'doc-top-1';

function makeAuths(startAt = 0) {
  let t = startAt;
  const auths = new AuthStore(() => t, TTL);
  return { auths, tick: (ms) => { t += ms; } };
}

/**
 * 授权记录的绑定值。
 *
 * frameId === 0 时目标就是顶层，两个 documentId 必须相同——
 * 这是真实语义（`getFrame({frameId:0})` 返回的就是顶层文档）。
 */
function bind(over = {}) {
  return {
    tabId: 7,
    frameId: 0,
    origin: ORIGIN,
    entryId: 'e1',
    username: 'u',
    documentId: TOPDOC,
    topDocumentId: TOPDOC,
    ...over,
  };
}

function claimOf(over = {}) {
  return {
    tabId: 7,
    frameId: 0,
    origin: ORIGIN,
    entryId: 'e1',
    ...over,
  };
}

/**
 * 可观测依赖：统计 getFrame / fill 调用次数。
 * 注意**没有 getTab**——这是刻意的，反映真实 Chrome 的权限模型。
 */
function makeDeps(opts = {}) {
  const calls = { getFrame: 0, fill: 0 };
  const delay = opts.delay ?? 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    calls,
    deps: {
      getFrame: async ({ frameId }) => {
        calls.getFrame += 1;
        if (delay) await sleep(delay);
        if (opts.frameThrows) throw new Error('frame gone');
        if (opts.frameNull) return null;

        // frameId === 0 就是顶层（主框架）。此时目标与顶层是同一个文档。
        const isTop = frameId === 0;

        if (isTop && opts.topMissingUrl) return { documentId: TOPDOC };
        if (!isTop && opts.targetMissingUrl) return { documentId: DOC };

        const url = isTop
          ? opts.topUrl ?? `${ORIGIN}/login`
          : opts.frameUrl ?? `${ORIGIN}/login`;
        // 显式 null = 模拟"该 frame 没有 documentId"。
        // 注意不能用 ?? 兜底，否则 null 会被替换成默认值。
        const explicitNull = isTop ? opts.topDocId === null : opts.docId === null;
        if (explicitNull) return { url }; // 无 documentId

        const docId = isTop ? opts.topDocId ?? TOPDOC : opts.docId ?? DOC;
        return { url, documentId: docId };
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

/* ==================== resolveFrame：origin 来源 ==================== */

test('PASS: getFrame 返回 url+documentId 时能解析出 origin', async () => {
  const { deps } = makeDeps();
  const r = await resolveFrame(deps, 7, 0);
  assert.ok(r);
  assert.equal(r.origin, ORIGIN);
  assert.equal(r.documentId, TOPDOC);
});

test('PASS: getFrame 返回 null → resolveFrame 返回 null', async () => {
  const { deps } = makeDeps({ frameNull: true });
  assert.equal(await resolveFrame(deps, 7, 0), null);
});

test('PASS: getFrame 抛异常 → resolveFrame 返回 null', async () => {
  const { deps } = makeDeps({ frameThrows: true });
  assert.equal(await resolveFrame(deps, 7, 0), null);
});

test('PASS: 缺 url → null', async () => {
  const { deps } = makeDeps({ topMissingUrl: true });
  assert.equal(await resolveFrame(deps, 7, 0), null);
});

test('PASS: 缺 documentId → null（不退回只校验 frameId）', async () => {
  const { deps } = makeDeps({ topDocId: null });
  assert.equal(await resolveFrame(deps, 7, 0), null, 'documentId 缺失必须拒绝');
});

test('PASS: 缺 documentId 时兑换被拒，密码零读取', async () => {
  const { auths } = makeAuths();
  auths.issue('nd1', bind());
  const { deps, calls } = makeDeps({ topDocId: null });
  const r = await redeemFill(auths, deps, 'nd1', claimOf());
  assert.equal(r.ok, false);
  assert.equal(calls.fill, 0);
});

test('PASS: 非 http/https 的 url → null', async () => {
  const { deps } = makeDeps({ topUrl: 'about:blank' });
  assert.equal(await resolveFrame(deps, 7, 0), null);
});

/* ==================== 正常兑换 ==================== */

test('PASS: 两个 documentId 均匹配 → 兑换成功', async () => {
  const { auths } = makeAuths();
  auths.issue('n1', bind());
  const { deps, calls } = makeDeps();
  const r = await redeemFill(auths, deps, 'n1', claimOf());
  assert.equal(r.ok, true);
  assert.equal(calls.fill, 1, '密码只读一次');
  assert.equal(auths.size(), 0, '成功后消费');
});

test('PASS: tabs.get 不返回 url 也能工作（origin 只来自 getFrame）', async () => {
  // 依赖里根本没有 getTab；能跑通即证明 origin 不再依赖 tabs.get
  const { auths } = makeAuths();
  auths.issue('n2', bind());
  const { deps } = makeDeps();
  const r = await redeemFill(auths, deps, 'n2', claimOf());
  assert.equal(r.ok, true);
});

/* ==================== documentId 不匹配 ==================== */

test('PASS: 目标 frame documentId 不一致（iframe）→ 拒绝，密码零读取', async () => {
  const { auths } = makeAuths();
  // frameId 5 = iframe，目标 documentId 与顶层分开
  auths.issue('n3', bind({ frameId: 5, documentId: 'doc-iframe-1' }));
  const { deps, calls } = makeDeps({ docId: 'doc-iframe-2' });
  const r = await redeemFill(auths, deps, 'n3', claimOf({ frameId: 5 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DOCUMENT_CHANGED');
  assert.equal(calls.fill, 0, '密码读取必须为 0');
});

test('PASS: 顶层 documentId 不一致 → 拒绝，密码零读取', async () => {
  const { auths } = makeAuths();
  auths.issue('n4', bind());
  const { deps, calls } = makeDeps({ topDocId: 'doc-top-2' });
  const r = await redeemFill(auths, deps, 'n4', claimOf());
  assert.equal(r.ok, false);
  // frameId=0 时目标即顶层，先撞到 DOCUMENT_CHANGED（同一文档）
  assert.ok(['DOCUMENT_CHANGED', 'TOP_DOCUMENT_CHANGED'].includes(r.error), r.error);
  assert.equal(calls.fill, 0);
});

test('PASS: 同 origin 导航但 documentId 改变 → 旧授权失效', async () => {
  const { auths } = makeAuths();
  auths.issue('n5', bind());
  // origin 完全相同，只有 documentId 变了
  const { deps, calls } = makeDeps({ topUrl: ORIGIN, topDocId: 'doc-top-new' });
  const r = await redeemFill(auths, deps, 'n5', claimOf());
  assert.equal(r.ok, false, '同 origin 导航必须让旧授权失效');
  assert.ok(['DOCUMENT_CHANGED', 'TOP_DOCUMENT_CHANGED'].includes(r.error), r.error);
  assert.equal(calls.fill, 0);
});

test('PASS: frameId 不变但 documentId 改变 → 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('n6', bind());
  const { deps } = makeDeps({ topDocId: 'changed' });
  const r = await redeemFill(auths, deps, 'n6', claimOf());
  assert.equal(r.ok, false);
});

test('PASS: 跨 origin 导航 → 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('n7', bind());
  const { deps } = makeDeps({ topUrl: 'https://evil.test/login', topDocId: TOPDOC });
  const r = await redeemFill(auths, deps, 'n7', claimOf());
  assert.equal(r.ok, false);
  // frameId=0 时目标即顶层，origin 变化先被目标校验拦下——
  // 两种错误码都表示"跨 origin 必须拒绝"，关键是不能放行。
  assert.ok(
    ['FRAME_ORIGIN_MISMATCH', 'TOP_ORIGIN_MISMATCH'].includes(r.error),
    r.error
  );
});

test('PASS: 目标 frame origin 不匹配（iframe）→ 拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('n8', bind({ frameId: 5, documentId: 'doc-iframe-1' }));
  const { deps } = makeDeps({ frameUrl: 'https://evil.test/x' });
  const r = await redeemFill(auths, deps, 'n8', claimOf({ frameId: 5 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FRAME_ORIGIN_MISMATCH');
});

/* ==================== 并发不退化 ==================== */

test('PASS: 100 并发仍只有 1 个成功，密码只读一次', async () => {
  const { auths } = makeAuths();
  auths.issue('c1', bind());
  const { deps, calls } = makeDeps({ delay: 5 });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'c1', claimOf()))
  );

  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(calls.fill, 1, '密码只能读一次');
  assert.equal(calls.getFrame, 2, '只校验目标与顶层各一次');
});

test('PASS: 100 并发 + 50ms 延迟仍只成功一次', async () => {
  const { auths } = makeAuths();
  auths.issue('c2', bind());
  const { deps, calls } = makeDeps({ delay: 50 });
  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'c2', claimOf()))
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(calls.fill, 1);
});

test('PASS: 并发中 getFrame 抛异常 → 全部拒绝，密码零读取', async () => {
  const { auths } = makeAuths();
  auths.issue('c3', bind());
  const { deps, calls } = makeDeps({ frameThrows: true });
  const results = await Promise.all(
    Array.from({ length: 100 }, () => redeemFill(auths, deps, 'c3', claimOf()))
  );
  assert.equal(results.filter((r) => r.ok).length, 0);
  assert.equal(calls.fill, 0);
});

/* ==================== 失败后不可重试 ==================== */

test('PASS: documentId 校验失败后旧 nonce 不可再次使用', async () => {
  const { auths } = makeAuths();
  auths.issue('r1', bind());
  const bad = makeDeps({ topDocId: 'other' });
  const r1 = await redeemFill(auths, bad.deps, 'r1', claimOf());
  assert.equal(r1.ok, false);

  // 即使换成正确 documentId 也无法重试
  const good = makeDeps();
  const r2 = await redeemFill(auths, good.deps, 'r1', claimOf());
  assert.equal(r2.ok, false, '销毁后不可重试');
  assert.equal(good.calls.fill, 0);
});

test('PASS: fill 抛错后记录销毁', async () => {
  const { auths } = makeAuths();
  auths.issue('r2', bind());
  const { deps } = makeDeps({ fillThrows: true });
  const r = await redeemFill(auths, deps, 'r2', claimOf());
  assert.equal(r.ok, false);
  assert.equal(auths.size(), 0);
});

/* ==================== 绑定校验（认领阶段）==================== */

test('PASS: frameId 不匹配 → 认领即拒绝，不调任何浏览器 API', async () => {
  const { auths } = makeAuths();
  auths.issue('b1', bind({ frameId: 3 }));
  const { deps, calls } = makeDeps();
  const r = await redeemFill(auths, deps, 'b1', claimOf({ frameId: 0 }));
  assert.equal(r.ok, false);
  assert.equal(calls.getFrame, 0, '绑定不符不应发起浏览器调用');
  assert.equal(calls.fill, 0);
});

test('PASS: entryId 不匹配 → 认领即拒绝', async () => {
  const { auths } = makeAuths();
  auths.issue('b2', bind());
  const { deps, calls } = makeDeps();
  const r = await redeemFill(auths, deps, 'b2', claimOf({ entryId: 'e2' }));
  assert.equal(r.ok, false);
  assert.equal(calls.getFrame, 0);
});

test('PASS: 目标 frame 与顶层 frame 分开校验（不混为一谈）', async () => {
  // 顶层正常、目标 frame 的 documentId 变了 → 必须拒绝
  const { auths } = makeAuths();
  auths.issue('b3', bind({ frameId: 5, documentId: 'doc-iframe-1' }));
  const { deps } = makeDeps({ docId: 'doc-iframe-2' });
  const r = await redeemFill(auths, deps, 'b3', claimOf({ frameId: 5 }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'DOCUMENT_CHANGED');
});
