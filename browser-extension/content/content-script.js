// Content script：只做两件事——找登录表单、把值写进去。
//
// 它**不知道** KeyNest 的存在，不持有 native port，不请求密码。
// 唯一能触发它动作的是 Service Worker 发来的 `do-fill`。

(() => {
  if (window.__keynestContentLoaded) return;
  window.__keynestContentLoaded = true;

  /**
   * 找页面里的登录表单：必须同时有"可见的密码框"和至少一个文本输入框。
   * @returns {{form: HTMLFormElement|null, user: HTMLInputElement|null, pass: HTMLInputElement}}
   *   | null
   */
  function findLoginFields() {
    const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => !el.disabled && !el.readOnly && isVisible(el)
    );
    if (passwords.length === 0) return null;

    const pass = passwords[0];
    const form = pass.form || pass.closest('form');

    // 用户名：同表单内第一个可见的 text/email/tel 输入框
    const scope = form || document;
    const user = Array.from(
      scope.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])')
    ).find((el) => !el.disabled && !el.readOnly && isVisible(el)) || null;

    return { form, user, pass };
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * 写入值并派发事件——很多框架（React/Vue）只认原生 setter + input 事件。
   */
  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 只处理来自扩展自身（Service Worker）的填充指令
    if (!msg || msg.type !== 'do-fill') return false;

    // origin 必须与当前页面一致——SW 已经校验过，这里再兜一层，
    // 防止有人用别的途径给 content script 投递消息
    const here = `${location.protocol}//${location.host}`.toLowerCase();
    if (typeof msg.origin !== 'string' || !here.startsWith(msg.origin)) {
      sendResponse({ ok: false, error: 'ORIGIN_MISMATCH' });
      return false;
    }

    const found = findLoginFields();
    if (!found) {
      sendResponse({ ok: false, error: 'NO_FORM' });
      return false;
    }

    try {
      // username 缺省就**不动**用户名字段。之前写空串会清掉用户已经敲进去的账号，
      // 用户点一下填充反而把号删了。
      if (found.user && typeof msg.username === 'string' && msg.username) {
        setValue(found.user, msg.username);
      }
      setValue(found.pass, msg.password || '');
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: 'FILL_FAILED' });
    } finally {
      // 不给闭包留下引用
      msg.password = null;
      msg.username = null;
    }
    return false;
  });

  // 告知 SW 本页已就绪（SW 据此判断能否注入）
  try {
    chrome.runtime.sendMessage({ type: 'content-ready' }).catch(() => {});
  } catch (e) {
    /* 扩展被重新加载时可能失败，忽略 */
  }
})();
