// 两个内置面板：密码填充、广告过滤暂停。
//
// # 为什么把面板从 popup.js 搬出来
//
// popup.js 原本同时做四件事：查标签页、问 KeyNest 状态、渲染列表、处理点击。
// 加第二个功能（广告过滤）后它开始分叉；再加第三个就会变成一堆 `if`。
//
// 现在 popup.js 只负责：建 PanelHost、注册面板、进入时调一次 renderAll。
// 每个面板自己知道「我要什么数据、我长什么样、点了做什么」。

/* ------------------------------------------------------------------ */
/* 密码填充                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {() => number|null} deps.getTabId
 */
export function createFillPanel(deps) {
  return {
    id: 'fill',
    // 不声明 moduleId：密码填充是核心模块，永远存在。
    // 声明了反而会依赖 modules.list 的返回，一旦那个接口出问题这里就整块消失了。
    order: 10,
    async render(host) {
      const tabId = deps.getTabId();

      // 1) 问 KeyNest 是否在线、是否解锁
      const status = await host.send('status');
      if (!status || !status.ok) {
        host.el('p', 'note', 'KeyNest 未运行。请先打开钥巢。');
        return;
      }
      if (status.data && status.data.locked) {
        host.el('p', 'note', 'KeyNest 已锁定。请先打开钥巢并解锁密码库。');
        return;
      }

      if (!Number.isInteger(tabId)) {
        host.el('p', 'note', '无法读取当前标签页。');
        return;
      }

      // 2) 查询匹配条目（不含密码）
      const res = await host.send('query', { tabId });
      if (!res || !res.ok) {
        host.el('p', 'note error', FILL_ERRORS[res && res.error] || `查询失败：${(res && res.error) || '未知错误'}`);
        return;
      }

      if (!res.entries || res.entries.length === 0) {
        host.el('p', 'note', '这个网站没有匹配的条目。');
        return;
      }

      host.el('p', 'hint', '点击条目即可填充到当前页面');
      const ul = host.el('ul', 'entries');

      for (const entry of res.entries) {
        const li = document.createElement('li');
        li.dataset.entryId = entry.id;
        li.dataset.username = entry.username || '';

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = typeof entry.title === 'string' ? entry.title : '';

        const user = document.createElement('span');
        user.className = 'user';
        user.textContent = typeof entry.username === 'string' ? entry.username : '';

        li.append(title, user);
        li.addEventListener('click', () => doFill(host, tabId, entry.id, entry.username));
        ul.append(li);
      }
    },
  };
}

/**
 * 浏览器桥接面板：显示扩展 ID，让用户复制给桌面程序。
 *
 * # 为什么必须有这个
 *
 * 浏览器只在**注册表**里找 Native Messaging 宿主，清单里的
 * `allowed_origins` 必须写**精确的扩展 ID**。而未发布到商店的扩展，
 * ID 是由安装路径的哈希决定的——**每台机器都不一样**。
 *
 * 所以桌面程序没法自己猜，只能由用户把这个 ID 告诉它。
 * 而这个 ID 只有扩展自己知道（`chrome.runtime.id`）。
 *
 * 少了这一段，用户装上扩展后看到的是「KeyNest 未运行」，
 * 而实际上桌面程序在运行、只是不知道该允许哪个扩展。
 */
const BRIDGE_PANEL = {
  id: 'bridge',
  // 不声明 moduleId：这不是一个功能模块，是一条安装指引。
  order: 5,
  async render(host) {
    // `chrome` 本身可能不存在（扩展被重载、页面在无扩展环境打开）。
    // 直接写 `chrome.runtime.id` 会抛 "Cannot read properties of undefined"。
    const id = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : null;
    if (!id) return;

    host.el('p', 'panel-host', '浏览器桥接');
    // ID 本身也作为文本放进 host.el——这样无障碍树与测试都能拿到它，
    // 不必去挖 DOM 结构。
    host.el(
      'p',
      'note',
      '把这个扩展 ID 填到钥巢的「设置 → 浏览器桥接 → 扩展 ID」，桌面程序才能连上本扩展。'
    );
    // ID 单独一行：它是**要被人抄走**的东西，混在说明文字里不好找。
    host.el('p', 'bridge-id-text', id);

    const row = document.createElement('div');
    row.className = 'bridge-id-row';

    const code = document.createElement('code');
    code.className = 'bridge-id';
    code.textContent = id;
    row.append(code);

    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(id);
        btn.textContent = '已复制';
        setTimeout(() => {
          btn.textContent = '复制';
        }, 1500);
      } catch {
        // 剪贴板可能被策略禁用：让用户自己选
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(code);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        btn.textContent = '请手动复制';
      }
    });
    row.append(btn);

    host.section.append(row);
  },
};

/**
 * 创建浏览器桥接面板（显示扩展 ID）。
 *
 * 单独一个工厂函数而不是直接导出常量——与其它面板保持一致的形状。
 */
export function createBridgePanel() {
  return BRIDGE_PANEL;
}

const FILL_ERRORS = {
  HTTP_NOT_ALLOWED: '该页面不是 HTTPS，已按策略禁止填充。',
  NO_ORIGIN: '这个页面没有可用的网址。',
  VAULT_LOCKED: 'KeyNest 已锁定。',
  TIMEOUT: 'KeyNest 没有响应。',
  HOST_DISCONNECTED: '与 KeyNest 的连接已断开。',
};

const FILL_RESULT_ERRORS = {
  AUTH_REJECTED: '授权校验未通过（可能页面已跳转或授权已过期）。',
  NO_FORM: '这个页面没有找到登录表单。',
  NO_PASSWORD: '条目里没有密码。',
  VAULT_LOCKED: 'KeyNest 已锁定，已拒绝填充。',
  REDEEM_FAILED: '兑换授权失败。',
};

/**
 * 唯一会取密码的动作：必须由用户点击触发。
 *
 * 两段式：
 *   1. `authorize-fill` —— SW 校验后签发一次性授权，把 nonce 交给 content script（**不含密码**）
 *   2. `redeem-now`     —— content script 出示 nonce 兑换，SW 重新校验 tab/origin 后才给密码
 *
 * popup 全程**拿不到密码**，也拿不到可用的授权令牌。
 */
async function doFill(host, tabId, entryId, username) {
  host.error(null);

  const auth = await host.send('authorize-fill', {
    tabId,
    entryId,
    username: typeof username === 'string' ? username : '',
  });

  if (!auth || !auth.ok) {
    host.error(
      FILL_ERRORS[auth && auth.error] ||
        {
          ENTRY_NOT_MATCHED: '该条目不属于当前网站。',
          NO_CONTENT_SCRIPT: '无法与页面通信，请刷新页面后重试。',
        }[auth && auth.error] ||
        `填充失败：${(auth && auth.error) || '未知错误'}`
    );
    return;
  }

  // 触发 content script 兑换（content script 持有 nonce，popup 不持有）
  let done = null;
  try {
    done = await depsSendToTab(host, tabId, entryId);
  } catch {
    host.error('无法与页面通信，请刷新页面后重试。');
    return;
  }

  if (!done || !done.ok) {
    host.error(FILL_RESULT_ERRORS[done && done.error] || `填充失败：${(done && done.error) || '未知错误'}`);
    return;
  }

  // 填充成功后立即关闭 popup：不给"密码还留在界面里"的机会
  window.close();
}

/**
 * 向 content script 发 `redeem-now`。
 *
 * 单独抽出来是因为它需要 `chrome.tabs.sendMessage`（不是发往 SW），
 * 而 popup 的 `send` 走的是 `chrome.runtime.sendMessage`。
 */
async function depsSendToTab(_host, tabId, entryId) {
  return chrome.tabs.sendMessage(tabId, { type: 'redeem-now', entryId }, { frameId: 0 });
}

/* ------------------------------------------------------------------ */
/* 广告过滤：按站点暂停                                                */
/* ------------------------------------------------------------------ */

/** 从 URL 里取 host。非 http(s) 返回 null。 */
function hostOfUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {() => string|null|undefined} deps.getTabUrl
 */
export function createAdblockPanel(deps) {
  const panel = {
    id: 'adblock',
    moduleId: 'adblock',
    order: 20,

    /**
     * 没有 tabs 权限时 `tab.url` 是 undefined；popup 作为标签页打开时
     * 活动标签页是它自己（chrome-extension://）。两种都拿不到域名。
     *
     * 看不到域名就没法"按站点暂停"，所以整块不显示——
     * **不是显示一个点了会失败的按钮**。
     */
    available: () => hostOfUrl(deps.getTabUrl()) !== null,

    async render(host) {
      const url = deps.getTabUrl();
      const hostName = hostOfUrl(url);
      if (!hostName) return;

      const status = await host.send('adblock.status');
      if (!status || !status.ok) return;

      const check = await host.send('adblock.check', { host: hostName });
      const allowed = !!(check && check.ok && check.allowed);

      const head = document.createElement('div');
      head.className = 'panel-head';
      const title = document.createElement('span');
      title.className = 'panel-title';
      title.textContent = '广告与跟踪器过滤';
      const badge = document.createElement('span');
      badge.className = 'badge';
      head.append(title, badge);
      host.section.append(head);

      host.el('p', 'panel-host', hostName);

      const btn = document.createElement('button');
      btn.className = 'ghost wide';
      host.section.append(btn);

      const note = document.createElement('p');
      note.className = 'panel-note hidden';
      host.section.append(note);

      if (status.mode === 'off' || status.mode === null) {
        badge.textContent = '未生效';
        btn.disabled = true;
        btn.textContent = '过滤已关闭（在设置里开启）';
        return;
      }

      if (allowed) {
        badge.textContent = '本站已暂停';
        badge.className = 'badge bad';
        btn.textContent = '恢复本站过滤';
      } else {
        badge.textContent = '本站已启用';
        badge.className = 'badge ok';
        btn.textContent = '在此站暂停过滤';
      }

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await host.send(allowed ? 'adblock.disallow' : 'adblock.allow', {
          domain: hostName,
        });
        btn.disabled = false;
        if (!res || !res.ok) {
          host.error(`操作失败：${(res && res.error) || '未知错误'}`);
          return;
        }
        host.error(null);
        note.textContent = allowed ? '已恢复过滤，刷新页面后生效' : '已暂停过滤，刷新页面后生效';
        note.classList.remove('hidden');
        // 重新渲染这一块（不是整个 popup：那会打断用户正在看的密码列表）
        host.section.replaceChildren();
        await panel.render(host);
      });
    },
  };
  return panel;
}

/* ------------------------------------------------------------------ */
/* 阅读模式                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {() => number|null} deps.getTabId
 */
export function createReaderPanel(deps) {
  const panel = {
    id: 'reader',
    moduleId: 'reader',
    order: 15, // 排在密码填充之后、广告之前

    /**
     * 注入只能在真实网页里做。popup 作为标签页打开时活动标签页是它自己
     * （chrome-extension://），`executeScript` 会直接失败。
     *
     * 预览里看不出区别，所以这里主动排掉——而不是让用户点一下看报错。
     */
    available: () => Number.isInteger(deps.getTabId()),

    async render(host) {
      const tabId = deps.getTabId();
      if (!Number.isInteger(tabId)) return;

      const state = await host.send('reader.query', { tabId });
      const active = !!(state && state.ok && state.active);

      const head = document.createElement('div');
      head.className = 'panel-head';
      const title = document.createElement('span');
      title.className = 'panel-title';
      title.textContent = '阅读模式';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = active ? '已开启' : '未开启';
      if (active) badge.className = 'badge ok';
      head.append(title, badge);
      host.section.append(head);

      host.el(
        'p',
        'panel-host',
        active ? '当前页面处于阅读模式' : '把文章页收敛成正文单列'
      );

      const btn = document.createElement('button');
      btn.className = 'ghost wide';
      btn.textContent = active ? '退出阅读模式' : '进入阅读模式';
      host.section.append(btn);

      const note = document.createElement('p');
      note.className = 'panel-note hidden';
      host.section.append(note);

      // 已开启时额外给一个「以后都别自动开」的入口。
      //
      // 主按钮的行为是**临时退出**（保留站点记忆），对应的选项必须在这里，
      // 否则用户想彻底关掉这个站点时会以为「退出」就是全部——
      // 结果下次刷新又自动开，反复几次就再也不用这个功能了。
      let forgetBtn = null;
      if (active) {
        forgetBtn = document.createElement('button');
        forgetBtn.className = 'linkish';
        forgetBtn.textContent = '以后不再自动为本站开启';
        host.section.append(forgetBtn);
      }

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await host.send('reader.toggle', {
          tabId,
          action: active ? 'uninstall' : 'install',
        });
        btn.disabled = false;

        if (!res || !res.ok) {
          // NO_CONTENT 是最常见的一种：这个页面看起来不像文章。
          // 给它单独一句话，而不是甩错误码。
          host.error(
            res && res.error === 'NO_CONTENT'
              ? '这个页面没有找到可提取的正文'
              : `操作失败：${(res && res.error) || '未知错误'}`
          );
          return;
        }

        host.error(null);
        // 重渲这一块（不是整个 popup：那会打断别的面板）
        host.section.replaceChildren();
        await panel.render(host);
      });

      if (forgetBtn) {
        forgetBtn.addEventListener('click', async () => {
          forgetBtn.disabled = true;
          const res = await host.send('reader.toggle', {
            tabId,
            action: 'uninstall',
            forget: true,
          });
          forgetBtn.disabled = false;
          if (!res || !res.ok) {
            host.error(`操作失败：${(res && res.error) || '未知错误'}`);
            return;
          }
          host.error(null);
          host.section.replaceChildren();
          await panel.render(host);
        });
      }
    },
  };
  return panel;
}

/* ------------------------------------------------------------------ */
/* 夜间模式                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {object} deps
 * @param {() => number|null} deps.getTabId
 */
export function createDarkPanel(deps) {
  const panel = {
    id: 'dark',
    moduleId: 'dark',
    order: 16,
    available: () => Number.isInteger(deps.getTabId()),

    async render(host) {
      const tabId = deps.getTabId();
      if (!Number.isInteger(tabId)) return;

      const state = await host.send('dark.query', { tabId });
      const active = !!(state && state.ok && state.active);

      const head = document.createElement('div');
      head.className = 'panel-head';
      const title = document.createElement('span');
      title.className = 'panel-title';
      title.textContent = '夜间模式';
      const badge = document.createElement('span');
      badge.className = active ? 'badge ok' : 'badge';
      badge.textContent = active ? '已开启' : '未开启';
      head.append(title, badge);
      host.section.append(head);

      host.el('p', 'panel-host', active ? '当前页面已调暗' : '把明亮页面调暗，图片保持原色');

      const btn = document.createElement('button');
      btn.className = 'ghost wide';
      btn.textContent = active ? '关闭夜间模式' : '开启夜间模式';
      host.section.append(btn);

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await host.send('dark.toggle', {
          tabId,
          action: active ? 'uninstall' : 'install',
        });
        btn.disabled = false;

        if (!res || !res.ok) {
          host.error(
            res && res.error === 'HOST_PERMISSION_DENIED'
              ? '需要本站点的访问权限，请在弹窗中允许后重试'
              : `操作失败：${(res && res.error) || '未知错误'}`
          );
          return;
        }
        host.error(null);
        host.section.replaceChildren();
        await panel.render(host);
      });
    },
  };
  return panel;
}
