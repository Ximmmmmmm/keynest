// 单页应用（SPA）的路由变化监听。
//
// # 为什么单独成文件
//
// 内容脚本不能 `import`（MV3 硬约束），但这段逻辑有真实的边界要测：
//
//   - 框架一次导航可能连着调好几次 `pushState`（先放占位再替换）
//   - `history` 可能被页面冻结或替换
//   - 补丁必须**转发原函数**，不能改变页面自己的行为
//
// 把纯逻辑放在这里由单元测试覆盖，内容脚本只负责调用。
// 两边的一致性由内容脚本里那段"照抄"保证——它只有十几行，
// 且不依赖任何外部状态。

/**
 * 给 `history.pushState` / `replaceState` 打补丁，让它们触发 `onChange`。
 *
 * # 为什么需要打补丁
 *
 * SPA 换页不重新加载文档，`popstate` 只在前进/后退时触发。
 * 框架内部跳转（点链接 → `pushState`）不会发出任何事件，
 * 于是"页面变了"这件事外人无从得知。
 *
 * # 三个必须做对的地方
 *
 * 1. **转发原函数并返回它的返回值**：有些代码依赖 `pushState` 的返回值，
 *    也有页面自己先打了补丁，我们必须在它之上而不是替换它。
 * 2. **保留 `this`**：用 `original.apply(this, args)`。
 *    写成 `original(...args)` 会让某些实现里的 `this` 变成 undefined。
 * 3. **单个失败不影响另一个**：`pushState` 被冻结时 `replaceState` 仍然该工作。
 *
 * @param {object} history 通常是 `window.history`
 * @param {() => void} onChange 路由可能变化时调用
 * @returns {{patched: string[], failed: string[]}}
 */
export function patchHistory(history, onChange) {
  const patched = [];
  const failed = [];

  for (const name of ['pushState', 'replaceState']) {
    try {
      const original = history[name];
      if (typeof original !== 'function') {
        failed.push(name);
        continue;
      }
      // 已经打过补丁就别再套一层：重复套会让一次导航触发多次回调
      if (original.__keynestPatched) {
        patched.push(name);
        continue;
      }
      const wrapper = function patchedState(...args) {
        const out = original.apply(this, args);
        try {
          onChange();
        } catch {
          // 回调自己的错不该让页面的导航失败
        }
        return out;
      };
      wrapper.__keynestPatched = true;
      history[name] = wrapper;
      patched.push(name);
    } catch {
      // 属性只读 / 被冻结：记下来，不影响另一个
      failed.push(name);
    }
  }

  return { patched, failed };
}

/**
 * 节流器：把一串密集调用合并成一次。
 *
 * 为什么需要：有些框架一次导航会连着调好几次 `pushState`
 * （先放占位再替换），每次都触发自动应用等于连发好几条消息，
 * 而结果完全一样。
 *
 * `delayMs` 取 250ms：足够合并这些抖动，又不至于让用户感到延迟。
 *
 * @param {() => void} fn
 * @param {number} delayMs
 * @param {{setTimeout:Function, clearTimeout:Function}} [timers]
 */
export function throttle(fn, delayMs, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  return {
    /** 排一次调用；已在排队中则忽略。 */
    schedule() {
      if (timer !== null) return;
      timer = timers.setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    /** 是否有待执行的调用（测试用）。 */
    get pending() {
      return timer !== null;
    },
  };
}
