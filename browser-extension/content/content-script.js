// Content script：只做三件事——找登录表单、兑换一次性授权、把值写进去。
//
// 它**不知道** KeyNest 的存在，不持有 native port，不签发授权。
// 唯一能拿到密码的路径是：向 Service Worker 出示 SW 自己签发的 nonce 并兑换。
//
// 注意：MV3 的 content script **不支持 ES module**，所以这里不能 `import`。
// 下面 `normalizeOrigin` 是 lib/origin.js 的等价实现，
// 由 tests/origin-parity.test.js 保证两边行为一致。

(() => {
  if (window.__keynestContentLoaded) return;
  window.__keynestContentLoaded = true;

  /** 待兑换的授权：{nonce, origin}，由 SW 的 prepare-fill 设置 */
  let pending = null;

  /**
   * origin 规范化（与 lib/origin.js 逐条等价）。
   * **绝不使用 startsWith / includes 做 origin 判据。**
   */
  function normalizeOrigin(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) return null;

    const idx = text.indexOf('://');
    if (idx <= 0) return null;
    const scheme = text.slice(0, idx).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;

    let rest = text.slice(idx + 3);
    const cut = rest.search(/[/?#]/);
    if (cut !== -1) rest = rest.slice(0, cut);

    const at = rest.lastIndexOf('@');
    if (at !== -1) rest = rest.slice(at + 1);
    if (!rest) return null;

    let host;
    let port = null;
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close === -1) return null;
      host = rest.slice(0, close + 1);
      const after = rest.slice(close + 1);
      if (after.startsWith(':')) port = after.slice(1);
      else if (after !== '') return null;
    } else {
      const colon = rest.lastIndexOf(':');
      if (colon !== -1) {
        host = rest.slice(0, colon);
        port = rest.slice(colon + 1);
      } else {
        host = rest;
      }
    }

    if (!host) return null;
    if (port !== null) {
      if (!/^[0-9]+$/.test(port)) return null;
      const isDefault =
        (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
      if (!isDefault) return `${scheme}://${host.toLowerCase()}:${port}`;
    }
    return `${scheme}://${host.toLowerCase()}`;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findLoginFields() {
    const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => !el.disabled && !el.readOnly && isVisible(el)
    );
    if (passwords.length === 0) return null;

    const pass = passwords[0];
    const form = pass.form || pass.closest('form');
    const scope = form || document;
    const user =
      Array.from(
        scope.querySelectorAll(
          'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
        )
      ).find((el) => !el.disabled && !el.readOnly && isVisible(el)) || null;

    return { form, user, pass };
  }

  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 当前页面的精确 origin（用浏览器给的 location.origin，再规范化对齐语义）。 */
  function currentOrigin() {
    return normalizeOrigin(location.origin || `${location.protocol}//${location.host}`);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    // ---- 第一步：SW 通知"用户点了填充，这是授权 nonce"（不含密码）----
    if (msg.type === 'prepare-fill') {
      const here = currentOrigin();
      // 授权里的 origin 必须与当前页面**精确相等**（不是前缀、不是包含）
      if (typeof msg.origin !== 'string' || here !== msg.origin) {
        sendResponse({ ok: false, error: 'ORIGIN_MISMATCH' });
        return false;
      }
      if (!findLoginFields()) {
        sendResponse({ ok: false, error: 'NO_FORM' });
        return false;
      }
      pending = { nonce: msg.nonce, origin: here };
      sendResponse({ ok: true });
      return false;
    }

    // ---- 第二步：出示 nonce 兑换密码并填充 ----
    if (msg.type === 'redeem-now') {
      if (!pending) {
        sendResponse({ ok: false, error: 'NO_PENDING' });
        return false;
      }
      const nonce = pending.nonce;

      chrome.runtime
        .sendMessage({ type: 'redeem-fill', nonce, entryId: msg.entryId })
        .then((res) => {
          pending = null;
          if (!res || !res.ok) {
            sendResponse({ ok: false, error: (res && res.error) || 'REDEEM_FAILED' });
            return;
          }
          const found = findLoginFields();
          if (!found) {
            sendResponse({ ok: false, error: 'NO_FORM' });
            return;
          }
          try {
            // username 缺省就**不动**用户名字段，避免清掉用户已输入的账号
            if (found.user && typeof res.username === 'string' && res.username) {
              setValue(found.user, res.username);
            }
            setValue(found.pass, res.password || '');
            sendResponse({ ok: true });
          } finally {
            res.password = null;
            res.username = null;
          }
        })
        .catch(() => {
          pending = null;
          sendResponse({ ok: false, error: 'REDEEM_FAILED' });
        });
      return true; // 异步响应
    }

    return false;
  });

  /* ------------------------------------------------------------------ */
  /* 页面加载后的自动应用                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 通知 SW："这个页面加载完了，看看有没有该自动打开的功能"。
   *
   * # 为什么由内容脚本发起，而不是 SW 自己听 onCommitted
   *
   * SW 监听 `webNavigation.onCommitted` 也有，但那个事件在 DOM 还没就绪时
   * 就会触发——注入的样式可能立刻被页面的后续渲染覆盖。
   *
   * 内容脚本本来就跑在 `document_idle`，那时 DOM 已稳定，是更合适的时机。
   *
   * # 为什么内容脚本不自己套样式
   *
   * 那样要把 `darkToggle` / `readerToggle` 复制进内容脚本——MV3 的内容脚本
   * 不支持 ES module，复制会导致**两份实现**，分叉风险与阅读模式那次相同。
   *
   * 所以这里只**发起请求**，注入仍由 SW 用 `executeScript` 完成。
   * 代价是多一次消息往返（几毫秒），换来的是注入函数始终只有一份。
   *
   * # 失败必须静默
   *
   * 自动应用失败（没权限、页面不是文章）是**正常情况**，不该打扰用户：
   * 不开任何 UI、不写 console、不弹提示。用户想用就自己去点。
   */
  function requestAutoApply() {
    const host = location.hostname ? location.hostname.toLowerCase() : '';
    if (!host) return;
    try {
      chrome.runtime
        .sendMessage({ type: 'auto.apply', host })
        .catch(() => {
          /* 扩展重载 / SW 未就绪：忽略，这是常态 */
        });
    } catch {
      /* 同上 */
    }
  }

  try {
    chrome.runtime.sendMessage({ type: 'content-ready' }).catch(() => {});
  } catch (e) {
    /* 扩展重载时可能失败，忽略 */
  }

  // 延后一点：给页面自己的首屏脚本一点时间，避免我们的滤镜被它覆盖
  try {
    if (document.readyState === 'complete') {
      setTimeout(requestAutoApply, 0);
    } else {
      window.addEventListener('load', () => setTimeout(requestAutoApply, 0), { once: true });
    }
  } catch {
    /* 环境异常时放弃自动应用，不影响手动填充 */
  }

  /* ------------------------------------------------------------------ */
  /* 单页应用（SPA）的路由变化                                           */
  /* ------------------------------------------------------------------ */

  /**
   * SPA 换页不重新加载文档，`load` 只触发一次，于是自动应用也只在第一次生效。
   *
   * 用户的实际经历：在列表页开了夜间模式，点进一篇文章——页面变回亮色。
   * 他不会想到「因为是单页应用」，只会觉得这个功能时灵时不灵。
   *
   * 监听两种信号：
   *   1. `popstate` —— 浏览器前进/后退
   *   2. 对 `history.pushState` / `replaceState` 打补丁 —— 框架内部跳转
   *
   * # 为什么要节流
   *
   * 有些框架一次导航会连着调好几次 `pushState`（先放占位再替换），
   * 每次都触发一次自动应用等于连发好几条消息，而结果完全一样。
   * 250ms 足够合并这些抖动，又不至于让用户感到延迟。
   */
  function watchRouteChanges() {
    let timer = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        requestAutoApply();
      }, 250);
    };

    try {
      window.addEventListener('popstate', schedule);
      window.addEventListener('hashchange', schedule);

      // 打补丁：框架用的是 history API，不会触发上面两个事件。
      // 语义与 lib/spa-router.js 的 patchHistory 一致——
      // 内容脚本不能 import，所以这里内联一份。
      // 三个必须做对的点：
      //   1. 转发原函数并返回它的返回值
      //   2. 保留 this（用 apply）
      //   3. 单个失败不影响另一个
      for (const name of ['pushState', 'replaceState']) {
        try {
          const original = history[name];
          if (typeof original !== 'function') continue;
          if (original.__keynestPatched) continue; // 别套两层
          const wrapper = function patched(...args) {
            const out = original.apply(this, args);
            try {
              schedule();
            } catch {
              /* 回调的错不该让导航失败 */
            }
            return out;
          };
          wrapper.__keynestPatched = true;
          history[name] = wrapper;
        } catch {
          /* 属性只读：跳过这个，另一个仍然尝试 */
        }
      }
    } catch {
      // 页面可能冻结了 history（少见），那就只保留首次应用
    }
  }

  try {
    watchRouteChanges();
  } catch {
    /* 同上：失败只是失去 SPA 支持，不影响首次应用 */
  }
})();
