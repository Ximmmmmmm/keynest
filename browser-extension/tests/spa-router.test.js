// SPA 路由监听的测试。
//
// 这段逻辑的失败模式都很安静：
//   - 补丁没转发原函数 → 页面自己的导航坏了（用户完全无法归因到扩展）
//   - 补丁丢了 this → 某些框架静默失效
//   - 没节流 → 一次导航连发好几条消息
//   - 重复打补丁 → 一次导航触发多次
//
// 所以测试重点全在"不该发生的事"上。

import test from 'node:test';
import assert from 'node:assert/strict';

import { patchHistory, throttle } from '../lib/spa-router.js';

/** 造一个最小的 history 替身。 */
function fakeHistory() {
  const calls = [];
  return {
    calls,
    pushState(state, title, url) {
      calls.push({ name: 'pushState', state, title, url, self: this });
      return 'push-return';
    },
    replaceState(state, title, url) {
      calls.push({ name: 'replaceState', state, title, url, self: this });
      return 'replace-return';
    },
  };
}

/* ============================ patchHistory ============================ */

test('PASS: 打补丁后调用会触发 onChange', () => {
  const history = fakeHistory();
  let hits = 0;
  patchHistory(history, () => {
    hits += 1;
  });

  history.pushState({}, '', '/a');
  assert.equal(hits, 1);
  history.replaceState({}, '', '/b');
  assert.equal(hits, 2);
});

test('FAIL-SAFE: 原函数必须被转发（含参数与返回值）', () => {
  const history = fakeHistory();
  patchHistory(history, () => {});

  const ret = history.pushState({ a: 1 }, 'title', '/x');
  assert.equal(ret, 'push-return', '返回值被吞掉了');

  assert.equal(history.calls.length, 1);
  assert.deepEqual(history.calls[0].state, { a: 1 });
  assert.equal(history.calls[0].title, 'title');
  assert.equal(history.calls[0].url, '/x');
});

test('FAIL-SAFE: 原函数必须收到正确的 this', () => {
  const history = fakeHistory();
  patchHistory(history, () => {});
  history.pushState({}, '', '/x');
  assert.equal(history.calls[0].self, history, 'this 丢了');
});

test('FAIL-SAFE: 重复打补丁不会叠加（一次导航只触发一次）', () => {
  const history = fakeHistory();
  let hits = 0;
  patchHistory(history, () => {
    hits += 1;
  });
  patchHistory(history, () => {
    hits += 1;
  });

  history.pushState({}, '', '/a');
  assert.equal(hits, 1, `触发了 ${hits} 次，说明补丁被套了两层`);
});

test('FAIL-SAFE: onChange 抛错不能让页面的导航失败', () => {
  const history = fakeHistory();
  patchHistory(history, () => {
    throw new Error('回调炸了');
  });

  // 不抛出去，且原函数仍然执行
  const ret = history.pushState({}, '', '/a');
  assert.equal(ret, 'push-return');
  assert.equal(history.calls.length, 1);
});

test('FAIL-SAFE: pushState 被冻结时 replaceState 仍然工作', () => {
  const history = fakeHistory();
  Object.defineProperty(history, 'pushState', {
    value: history.pushState,
    writable: false,
    configurable: false,
  });

  let hits = 0;
  const r = patchHistory(history, () => {
    hits += 1;
  });

  assert.ok(r.failed.includes('pushState'), '应当报告 pushState 失败');
  assert.ok(r.patched.includes('replaceState'), 'replaceState 应当仍然打上');

  history.replaceState({}, '', '/b');
  assert.equal(hits, 1);
});

test('FAIL-SAFE: 缺少某个方法时只报告，不抛错', () => {
  const history = { pushState() {} }; // 没有 replaceState
  const r = patchHistory(history, () => {});
  assert.deepEqual(r.patched, ['pushState']);
  assert.deepEqual(r.failed, ['replaceState']);
});

/* ============================ throttle ============================ */

/** 可控的定时器：让测试不必真的等。 */
function fakeTimers() {
  let seq = 0;
  const queued = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      queued.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout(id) {
      queued.delete(id);
    },
    /** 把排队的回调全部执行掉。 */
    flush() {
      const items = [...queued.values()];
      queued.clear();
      for (const it of items) it.fn();
    },
    get size() {
      return queued.size;
    },
  };
}

test('PASS: 密集调用被合并成一次', () => {
  let hits = 0;
  const t = fakeTimers();
  const th = throttle(() => {
    hits += 1;
  }, 250, t);

  th.schedule();
  th.schedule();
  th.schedule();
  assert.equal(t.size, 1, '应当只有一个待执行的定时器');

  t.flush();
  assert.equal(hits, 1, `合并后应当只触发一次，实际 ${hits}`);
});

test('PASS: 执行完之后可以再次排队', () => {
  let hits = 0;
  const t = fakeTimers();
  const th = throttle(() => {
    hits += 1;
  }, 250, t);

  th.schedule();
  t.flush();
  th.schedule();
  t.flush();
  assert.equal(hits, 2);
});

test('PASS: pending 反映是否在排队', () => {
  const t = fakeTimers();
  const th = throttle(() => {}, 250, t);
  assert.equal(th.pending, false);
  th.schedule();
  assert.equal(th.pending, true);
  t.flush();
  assert.equal(th.pending, false);
});

test('PASS: 延迟值被传给定时器', () => {
  const seen = [];
  const t = {
    setTimeout(fn, ms) {
      seen.push(ms);
      return 1;
    },
    clearTimeout() {},
  };
  const th = throttle(() => {}, 250, t);
  th.schedule();
  assert.deepEqual(seen, [250]);
});

/* ============================ 与内容脚本的一致性 ============================ */

/**
 * 内容脚本不能 `import`，所以它内联了一份等价的补丁逻辑。
 *
 * 两份实现分叉的表现：单元测试用 `patchHistory` 全绿，
 * 真实页面里内容脚本那份却没转发原函数 / 丢了 this，
 * 于是**页面自己的导航坏了**——而用户完全无法归因到扩展。
 *
 * 这里把内容脚本里那段代码原样取出来跑一遍，断言行为与
 * `patchHistory` 一致。
 */
test('FAIL-SAFE: 内容脚本的补丁逻辑与 patchHistory 行为一致', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../content/content-script.js', import.meta.url), 'utf8');

  // 只取 watchRouteChanges 里的 for 循环那一段。
  //
  // 用花括号配平而不是固定缩进的字符串：内容脚本的缩进随嵌套层级变化，
  // 写死空格数会让这条测试在下一次格式化后莫名其妙地失效。
  const startMatch = src.match(/for \(const name of \['pushState', 'replaceState'\]\) \{/);
  assert.ok(startMatch, '内容脚本里找不到补丁代码（可能被重构了）');
  const start = startMatch.index;

  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > start, '没找到 for 循环的结尾');
  const snippet = src.slice(start, end);

  // 构造与 patchHistory 测试相同的场景
  const makeHistory = () => {
    const calls = [];
    return {
      calls,
      pushState(s, t, u) {
        calls.push({ name: 'pushState', self: this });
        return 'push-return';
      },
      replaceState(s, t, u) {
        calls.push({ name: 'replaceState', self: this });
        return 'replace-return';
      },
    };
  };

  for (const impl of ['patchHistory', 'content-script']) {
    const history = makeHistory();
    let hits = 0;
    const schedule = () => {
      hits += 1;
    };

    if (impl === 'patchHistory') {
      patchHistory(history, schedule);
    } else {
      // 用它自己那份逻辑：把 snippet 包进一个函数里执行
      // eslint-disable-next-line no-new-func
      const run = new Function('history', 'schedule', snippet);
      run(history, schedule);
    }

    const ret = history.pushState({}, '', '/x');
    assert.equal(ret, 'push-return', `${impl}: 返回值被吞了`);
    assert.equal(history.calls[0].self, history, `${impl}: this 丢了`);
    assert.equal(hits, 1, `${impl}: 回调次数不对`);

    // 重复打补丁不应叠加
    if (impl === 'patchHistory') {
      patchHistory(history, schedule);
    } else {
      // eslint-disable-next-line no-new-func
      const run2 = new Function('history', 'schedule', snippet);
      run2(history, schedule);
    }
    history.pushState({}, '', '/y');
    assert.equal(hits, 2, `${impl}: 补丁被套了两层`);
  }
});
