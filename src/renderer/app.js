'use strict';

/* ============================================================
   钥巢 KeyNest — 渲染进程
   所有数据来自主进程解密后的快照；本文件不接触密钥与文件系统。
   ============================================================ */

const api = window.vaultApi;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);

const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

/** 文件大小，用于导入卡片 */
const formatSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};


const state = {
  exists: false,
  unlocked: false,
  creating: false,
  entries: [],
  categories: [],
  settings: { autoLockMinutes: 5, clipboardClearSeconds: 30, revealSeconds: 20 },
  query: '',
  category: 'all',
  selectedId: null,
  sort: 'updated',
  revealed: new Set(),
  revealTimers: new Map(),
  vaultPath: '',
  version: '',
};

/* ---------------- 颜色与工具 ---------------- */

const PALETTE = [
  { fg: '#4a58d8', bg: '#eef0ff' },
  { fg: '#0e8a7a', bg: '#e5f6f1' },
  { fg: '#9c57c1', bg: '#f5ecfb' },
  { fg: '#b0701a', bg: '#fdf2e2' },
  { fg: '#c0563f', bg: '#fdeee9' },
  { fg: '#3d7a9e', bg: '#e9f3f9' },
  { fg: '#5f6b7a', bg: '#eef0f4' },
  { fg: '#7d6a2c', bg: '#f7f2dc' },
];

const KNOWN_COLORS = { 网站: 0, 邮箱: 1, 应用: 2, 金融: 3, 其他: 6 };

function colorFor(name) {
  if (KNOWN_COLORS[name] != null) return PALETTE[KNOWN_COLORS[name]];
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 9973;
  return PALETTE[h % PALETTE.length];
}

function initialOf(text) {
  const value = String(text || '').trim();
  return value ? value[0].toUpperCase() : '?';
}

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '未知';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function fullTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 与主进程 password.js 同一套算法，仅用于界面即时反馈 */
function strengthOf(password) {
  const pw = String(password || '');
  if (!pw) return { score: 0, label: '', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 28;
  const unique = new Set(pw).size;
  let bits = Math.round(pw.length * Math.log2(Math.min(pool, Math.max(unique * 4, 2))));
  if (/(.)\1{2,}/.test(pw) || /(012|123|234|345|456|567|678|789|abc|qwe|asd|password|admin)/i.test(pw)) {
    bits = Math.round(bits * 0.7);
  }
  const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, bits, label: ['', '弱', '一般', '强', '很强'][score] };
}

/* ---------------- Toast ---------------- */

function toast(message, kind = 'ok') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check')}<span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

/* ---------------- 弹层 ---------------- */

function openModal(html, { wide = false, onMount, onClose } = {}) {
  const root = $('#modalRoot');
  const stacked = root.children.length > 0;
  const wrap = document.createElement('div');
  wrap.className = `modal-backdrop${stacked ? ' stacked' : ''}`;
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(wrap);

  const modal = $('.modal', wrap);
  wrap.addEventListener('mousedown', (event) => {
    if (event.target === wrap) closeModal();
  });
  if (onClose) wrap._onClose = onClose;
  if (onMount) onMount(modal);

  // 只把焦点交给文本类输入，避免确认框里给关闭按钮套上焦点环
  const focusTarget = modal.querySelector(
    'input[type="text"], input[type="password"], input[type="search"], input:not([type]), textarea, select',
  );
  if (focusTarget) setTimeout(() => focusTarget.focus(), 40);
  return modal;
}

function closeModal() {
  const last = $('#modalRoot').lastElementChild;
  if (!last) return;
  const hook = last._onClose;
  last.remove();
  if (hook) hook();
}

function closeAllModals() {
  const root = $('#modalRoot');
  while (root.lastElementChild) {
    const last = root.lastElementChild;
    const hook = last._onClose;
    last.remove();
    if (hook) hook();
  }
}

function modalHeader(title, desc) {
  return `<div class="modal-head">
    <div>
      <h3>${esc(title)}</h3>
      ${desc ? `<p>${esc(desc)}</p>` : ''}
    </div>
    <button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
  </div>`;
}

function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openModal(
      `${modalHeader(title)}
       <div class="modal-body" style="padding-bottom:16px"><p class="confirm-copy">${message}</p></div>
       <div class="modal-foot">
         <button class="btn ghost" data-action="confirm-no">取消</button>
         <button class="btn ${danger ? 'danger' : 'primary'}" data-action="confirm-yes">${esc(confirmText)}</button>
       </div>`,
      {
        onClose: () => finish(false),
        onMount(modal) {
          modal.querySelector('[data-action="confirm-yes"]').addEventListener('click', () => {
            finish(true);
            closeModal();
          });
          modal.querySelector('[data-action="confirm-no"]').addEventListener('click', () => {
            finish(false);
            closeModal();
          });
          modal.querySelector('[data-action="close-modal"]').addEventListener('click', () => {
            finish(false);
            closeModal();
          });
        },
      },
    );
  });
}

/* ---------------- 锁屏 ---------------- */

const lockScreen = $('#lockScreen');
const shell = $('#shell');
const masterInput = $('#masterInput');
const masterConfirm = $('#masterConfirm');
const lockBtn = $('#lockBtn');
const lockError = $('#lockError');

function showLockError(message) {
  lockError.textContent = message || '';
  lockError.classList.toggle('show', !!message);
}

function setSetupMode(creating) {
  state.creating = creating;
  $('#confirmWrap').hidden = !creating;
  $('#setupMeter').hidden = !creating;
  $('#lockTitle').textContent = creating ? '设置主密码' : '解锁密码库';
  $('#lockSub').textContent = creating
    ? '主密码是打开密码库的唯一钥匙。它不会写入磁盘，也无法找回，请务必牢记。'
    : '主密码仅用于本机解密，不会上传，也不会写入磁盘。';
  lockBtn.textContent = creating ? '创建密码库' : '解锁';
  $('#lockFootText').textContent = creating
    ? '建议使用 12 位以上、包含符号的独立密码'
    : 'AES-256-GCM 加密 · scrypt 密钥派生 · 数据仅存本机';
  lockConfirmHint();
}

function lockConfirmHint() {
  if (!state.creating) return;
  const pw = masterInput.value;
  const meter = $('#setupMeter');
  const info = strengthOf(pw);
  meter.dataset.score = pw ? String(info.score) : '0';
  $('#setupMeterLabel').textContent = pw ? `${info.label} · ${info.bits} bit` : '至少 8 位';
}

masterInput.addEventListener('input', () => {
  showLockError('');
  if (!state.creating) return;
  const pw = masterInput.value;
  const info = strengthOf(pw);
  $('#setupMeter').dataset.score = pw ? String(info.score) : '0';
  $('#setupMeterLabel').textContent = pw ? `${info.label} · ${info.bits} bit` : '至少 8 位';
});

$('#lockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (lockBtn.disabled) return;
  const password = masterInput.value;
  if (!password) return showLockError('请输入主密码');

  if (state.creating) {
    if (password.length < 8) return showLockError('主密码至少 8 位');
    if (password !== masterConfirm.value) return showLockError('两次输入的主密码不一致');
    if (strengthOf(password).score < 2) {
      const go = await confirmDialog({
        title: '密码强度偏低',
        message: '这个主密码较短或过于简单，存在被离线暴力破解的风险。<br>仍然继续创建吗？',
        confirmText: '仍然使用',
        danger: true,
      });
      if (!go) return;
    }
  }

  lockBtn.disabled = true;
  const original = lockBtn.textContent;
  const isCreating = state.creating;
  lockBtn.textContent = isCreating ? '正在创建…' : '正在解密…';
  showLockError('');

  const res = isCreating ? await api.create(password) : await api.unlock(password);
  lockBtn.disabled = false;
  lockBtn.textContent = original;

  if (!res.ok) {
    const map = {
      INVALID_PASSWORD: '主密码错误，请重试',
      CORRUPT: '仓库文件损坏，无法解密',
      NO_VAULT: '还没有创建密码库',
      ALREADY_EXISTS: '密码库已存在，请重新启动',
    };
    showLockError(map[res.error.code] || res.error.message);
    masterInput.select();
    return;
  }

  state.exists = true;
  masterInput.value = '';
  masterConfirm.value = '';
  enterApp(res.data);
});

/* ---------------- 应用状态 ---------------- */

function applySnapshot(snapshot) {
  state.entries = snapshot.entries || [];
  state.categories = snapshot.categories || [];
  state.settings = Object.assign({}, state.settings, snapshot.settings || {});
}

function enterApp(snapshot) {
  state.unlocked = true;
  applySnapshot(snapshot);
  lockScreen.classList.add('is-hidden');
  shell.hidden = false;
  shell.classList.remove('detail-open', 'drawer-open');
  renderAll();
  if (window.innerWidth > 980) {
    const list = visibleEntries();
    if (list.length) selectEntry(list[0].id, { silent: true });
  }
  maybePromptImport(snapshot);
}

function resetToLock(reason = 'manual') {
  state.unlocked = false;
  state.entries = [];
  state.categories = [];
  state.selectedId = null;
  state.query = '';
  state.category = 'all';
  state.revealed.clear();
  for (const timer of state.revealTimers.values()) clearTimeout(timer);
  state.revealTimers.clear();
  closeAllModals();
  shell.hidden = true;
  shell.classList.remove('detail-open', 'drawer-open');
  lockScreen.classList.remove('is-hidden');
  $('#searchInput').value = '';
  masterInput.value = '';
  masterConfirm.value = '';
  showLockError('');
  lockBtn.disabled = false;
  setSetupMode(!state.exists);
  if (reason === 'idle') {
    $('#lockSub').textContent = '长时间未操作，已自动锁定。请重新输入主密码。';
    $('#lockTitle').textContent = '已锁定';
    lockBtn.textContent = '解锁';
  } else {
    $('#lockTitle').textContent = state.exists ? '密码库已锁定' : '设置主密码';
  }
  setTimeout(() => masterInput.focus(), 120);
}

/* ---------------- 渲染：分类 ---------------- */

function countByCategory(name) {
  if (name === 'all') return state.entries.length;
  return state.entries.filter((e) => e.category === name).length;
}

function renderCategories() {
  const items = [{ name: 'all', label: '全部条目' }, ...state.categories.map((c) => ({ name: c, label: c }))];
  const html = items
    .map((item) => {
      const color = item.name === 'all' ? { fg: '#4a58d8', bg: '#eef0ff' } : colorFor(item.name);
      const glyph = item.name === 'all' ? icon('grid') : esc(item.label.slice(0, 1));
      const active = state.category === item.name ? 'active' : '';
      return `<button class="cat-item ${active}" data-action="filter" data-category="${esc(item.name)}" title="${esc(item.label)}">
        <span class="cat-glyph" style="--glyph-bg:${color.bg};--glyph-fg:${color.fg}">${glyph}</span>
        <span class="cat-name">${esc(item.label)}</span>
        <span class="cat-count">${countByCategory(item.name)}</span>
      </button>`;
    })
    .join('');
  $('#categoryNav').innerHTML = html;
}

/* ---------------- 渲染：列表 ---------------- */

function visibleEntries() {
  const q = state.query.trim().toLowerCase();
  let list = state.entries.filter((e) => state.category === 'all' || e.category === state.category);
  if (q) {
    list = list.filter((e) =>
      [e.title, e.username, e.url, e.notes, e.category].join('\n').toLowerCase().includes(q),
    );
  }
  list = list.slice().sort((a, b) => {
    if (state.sort === 'title') return a.title.localeCompare(b.title, 'zh-CN');
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return list;
}

function renderList() {
  const list = visibleEntries();
  const total = state.entries.length;
  const title = state.category === 'all' ? '全部条目' : state.category;
  $('#listTitle').textContent = title;
  $('#listCount').textContent = String(list.length);
  $('#entryTotal').textContent = `共 ${total} 条`;

  const container = $('#entryList');
  container.innerHTML = list
    .map((entry) => {
      const color = colorFor(entry.category);
      const sub = entry.username || entry.url || '未填写账号';
      return `<div class="entry ${state.selectedId === entry.id ? 'active' : ''}" data-action="select" data-id="${esc(entry.id)}" role="option" tabindex="0">
        <div class="entry-avatar" style="--avatar:${color.fg};--avatar-bg:${color.bg}">${esc(initialOf(entry.title))}</div>
        <div class="entry-main">
          <div class="entry-title">${esc(entry.title)}</div>
          <div class="entry-sub">${esc(sub)}</div>
        </div>
        <div class="entry-actions">
          <button class="icon-btn" data-action="copy-username" data-id="${esc(entry.id)}" title="复制账号">${icon('user')}</button>
          <button class="icon-btn" data-action="copy-password" data-id="${esc(entry.id)}" title="复制密码">${icon('key')}</button>
        </div>
      </div>`;
    })
    .join('');

  const empty = list.length === 0;
  $('#listEmpty').hidden = !empty;
  container.hidden = empty;
  if (empty) {
    const hasFilter = state.query.trim() || state.category !== 'all';
    $('#listEmptyText').textContent = total === 0 ? '还没有任何条目' : '没有找到匹配的条目';
    $('#emptyResetBtn').hidden = !hasFilter;
    $('#emptyResetBtn').textContent = total === 0 ? '新建第一条' : '清除筛选';
  }
}

/* ---------------- 渲染：详情 ---------------- */

function selectedEntry() {
  return state.entries.find((e) => e.id === state.selectedId) || null;
}

function renderDetail() {
  const pane = $('#detailPane');
  const entry = selectedEntry();
  if (!entry) {
    pane.innerHTML = `<div class="detail-empty">
      <div class="detail-empty-art">${icon('shield')}</div>
      <h3>每把钥匙，都有归处</h3>
      <p>从左侧选择一条条目查看详情；密码默认掩码，点击眼睛图标后 ${state.settings.revealSeconds || 20} 秒自动隐藏。</p>
      <button class="btn" data-action="new">${icon('plus')} 新建条目</button>
    </div>`;
    return;
  }

  const color = colorFor(entry.category);
  const revealed = state.revealed.has(entry.id);
  const info = strengthOf(entry.password);
  const masked = '•'.repeat(Math.min(Math.max(entry.password.length, 8), 16));
  const changed = state.selectedId === renderDetail.lastId;
  renderDetail.lastId = state.selectedId;

  const field = (label, iconName, value, { mono = false, fieldName = '', link = false } = {}) => {
    const empty = !value;
    return `<div class="field-row">
      <div class="field-key">${icon(iconName)}<span>${label}</span></div>
      <div class="field-main">
        <div class="field-text ${mono ? 'mono' : ''} ${link ? 'link' : ''} ${empty ? 'empty' : ''}">${empty ? '未填写' : esc(value)}</div>
        ${
          empty
            ? ''
            : `<div class="field-actions">
                ${link ? `<button class="icon-btn" data-action="open-url" title="在浏览器中打开">${icon('external')}</button>` : ''}
                <button class="icon-btn" data-action="copy-field" data-field="${fieldName}" title="复制">${icon('copy')}</button>
              </div>`
        }
      </div>
    </div>`;
  };

  pane.innerHTML = `
    <div class="detail-head">
      <button class="icon-btn detail-back" data-action="back" aria-label="返回列表">${icon('back')}</button>
      <div class="detail-avatar" style="--avatar:${color.fg};--avatar-bg:${color.bg}">${esc(initialOf(entry.title))}</div>
      <div class="detail-titles">
        <h2>${esc(entry.title)}</h2>
        <div class="detail-meta">
          <span class="chip" style="--chip-bg:${color.bg};--chip-fg:${color.fg}">${esc(entry.category)}</span>
          <span>更新于 ${esc(relativeTime(entry.updatedAt))}</span>
        </div>
      </div>
      <div class="detail-head-actions">
        <button class="btn sm" data-action="edit">${icon('edit')}<span class="label">编辑</span></button>
        <button class="btn sm danger" data-action="delete">${icon('trash')}<span class="label">删除</span></button>
      </div>
    </div>
    <div class="detail-scroll">
      <div class="detail-inner" ${changed ? 'style="animation:none"' : ''}>
        <div class="secret-card">
          <div class="secret-top">
            <span class="secret-label">密码</span>
            <div class="secret-actions">
              <button class="icon-btn" data-action="toggle-reveal" title="${revealed ? '隐藏' : '显示'}密码">${icon(revealed ? 'eye-off' : 'eye')}</button>
              <button class="icon-btn" data-action="copy-password" title="复制密码">${icon('copy')}</button>
            </div>
          </div>
          <div class="secret-value ${revealed || !entry.password ? '' : 'masked'}">${
            entry.password ? (revealed ? esc(entry.password) : masked) : '未设置密码'
          }</div>
          <div class="secret-foot">
            ${
              entry.password
                ? `<span class="strength" data-score="${info.score}"><span class="strength-bars"><i></i><i></i><i></i><i></i></span><span>${info.label} · ${info.bits} bit</span></span>
                   <span>·</span><span>${entry.password.length} 位</span>`
                : '<span>尚未设置密码</span>'
            }
            ${revealed && state.settings.revealSeconds > 0 ? `<span>·</span><span>${state.settings.revealSeconds} 秒后隐藏</span>` : ''}
          </div>
        </div>

        <div class="detail-card">
          ${field('账号', 'user', entry.username, { fieldName: 'username', mono: true })}
          ${field('网站', 'link', entry.url, { fieldName: 'url', link: true })}
          <div class="field-row">
            <div class="field-key">${icon('note')}<span>备注</span></div>
            <div class="field-main">
              <div class="field-text ${entry.notes ? '' : 'empty'}">${
                entry.notes ? `<span class="notes-text">${esc(entry.notes)}</span>` : '未填写'
              }</div>
            </div>
          </div>
        </div>

        <div class="detail-footnote">
          ${icon('clock')}<span>创建于 ${esc(fullTime(entry.createdAt))} · 最近修改 ${esc(fullTime(entry.updatedAt))}</span>
        </div>
      </div>
    </div>`;
}

/* ---------------- 渲染：总入口 ---------------- */

function renderAll() {
  renderCategories();
  renderList();
  renderDetail();
}

/* ---------------- 交互 ---------------- */

function selectEntry(id, { silent = false } = {}) {
  state.selectedId = id;
  renderList();
  renderDetail();
  if (!silent && window.matchMedia('(max-width: 980px)').matches) {
    shell.classList.add('detail-open');
  }
}

function clearReveal(id) {
  const timer = state.revealTimers.get(id);
  if (timer) clearTimeout(timer);
  state.revealTimers.delete(id);
  state.revealed.delete(id);
}

async function copyValue(text, { sensitive = false, label = '已复制' } = {}) {
  if (!text) {
    toast('没有可复制的内容', 'error');
    return;
  }
  const res = await api.copy(text, sensitive);
  if (!res.ok) {
    toast('复制失败', 'error');
    return;
  }
  const seconds = res.data && res.data.clearedIn;
  toast(sensitive && seconds > 0 ? `${label}，${seconds} 秒后自动清除剪贴板` : label);
}

function openEditor(entry) {
  const editing = !!entry;
  const data = entry || {
    title: '',
    username: '',
    password: '',
    url: '',
    category: state.category === 'all' ? '网站' : state.category,
    notes: '',
  };
  const categories = state.categories.map((c) => `<option value="${esc(c)}"></option>`).join('');

  openModal(
    `${modalHeader(editing ? '编辑条目' : '新建条目', editing ? '修改后立即加密保存' : '所有字段都会写入加密仓库')}
      <form id="entryForm">
        <div class="modal-body">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">标题 <span class="opt">必填</span></span>
              <input class="input" id="fTitle" maxlength="200" placeholder="例如：GitHub" value="${esc(data.title)}" required />
            </label>
            <label class="field">
              <span class="field-label">账号 / 用户名</span>
              <input class="input" id="fUsername" maxlength="300" placeholder="邮箱或用户名" value="${esc(data.username)}" />
            </label>
            <div class="field">
              <span class="field-label">密码</span>
              <div class="pw-row">
                <input class="input" id="fPassword" maxlength="1024" type="password" placeholder="输入或生成密码" value="${esc(data.password)}" />
                <button type="button" class="icon-btn" data-toggle-password="fPassword" title="显示/隐藏">${icon('eye')}</button>
                <button type="button" class="icon-btn" data-action="open-generator" title="生成密码">${icon('wand')}</button>
              </div>
              <span class="field-hint" id="fPwHint">—</span>
            </div>
            <div class="two-col">
              <label class="field">
                <span class="field-label">网站 / 地址</span>
                <input class="input" id="fUrl" maxlength="500" placeholder="https://example.com" value="${esc(data.url)}" />
              </label>
              <label class="field">
                <span class="field-label">分类</span>
                <input class="input" id="fCategory" maxlength="40" list="catOptions" placeholder="选择或输入" value="${esc(data.category)}" />
                <datalist id="catOptions">${categories}</datalist>
              </label>
            </div>
            <label class="field">
              <span class="field-label">备注</span>
              <textarea class="textarea" id="fNotes" maxlength="5000" placeholder="安全问题、备用邮箱、续费日期…">${esc(data.notes)}</textarea>
            </label>
          </div>
          <p class="form-error" id="editorError" role="alert"></p>
        </div>
        <div class="modal-foot">
          ${editing ? `<button type="button" class="btn ghost danger" data-action="delete-entry" data-id="${esc(entry.id)}" style="margin-right:auto">${icon('trash')} 删除</button>` : ''}
          <button type="button" class="btn ghost" data-action="close-modal">取消</button>
          <button type="submit" class="btn primary" id="saveEntryBtn">${editing ? '保存修改' : '保存条目'}</button>
        </div>
      </form>`,
    {
      wide: true,
      onMount(modal) {
        const pw = modal.querySelector('#fPassword');
        const hint = modal.querySelector('#fPwHint');
        const update = () => {
          const info = strengthOf(pw.value);
          hint.textContent = pw.value
            ? `强度：${info.label} · 约 ${info.bits} bit 熵`
            : '建议使用生成器创建 16 位以上随机密码';
          hint.style.color = info.score && info.score <= 1 ? 'var(--danger)' : '';
        };
        pw.addEventListener('input', update);
        update();
        modal.querySelector('#entryForm').addEventListener('submit', async (event) => {
          event.preventDefault();
          const title = modal.querySelector('#fTitle').value.trim();
          if (!title) {
            const err = modal.querySelector('#editorError');
            err.textContent = '请填写标题';
            err.classList.add('show');
            return;
          }
          const button = modal.querySelector('#saveEntryBtn');
          button.disabled = true;
          button.textContent = '保存中…';
          const payload = {
            id: editing ? entry.id : undefined,
            title,
            username: modal.querySelector('#fUsername').value,
            password: pw.value,
            url: modal.querySelector('#fUrl').value,
            category: modal.querySelector('#fCategory').value.trim() || '其他',
            notes: modal.querySelector('#fNotes').value,
          };
          const res = await api.saveEntry(payload);
          button.disabled = false;
          if (!res.ok) {
            const err = modal.querySelector('#editorError');
            err.textContent = res.error.message;
            err.classList.add('show');
            return;
          }
          applySnapshot(res.data.snapshot);
          state.selectedId = res.data.entry.id;
          closeModal();
          renderAll();
          toast(editing ? '修改已保存' : '条目已加密保存');
        });
      },
    },
  );
}

function openGenerator({ onUse } = {}) {
  const options = { length: 20, lower: true, upper: true, digits: true, symbols: true, excludeAmbiguous: true };

  const modal = openModal(
    `${modalHeader('密码生成器', '使用系统级随机数生成，每个字符集至少出现一次')}
      <div class="modal-body">
        <div class="gen-output">
          <span class="gen-text" id="genText">…</span>
          <button class="icon-btn" data-action="gen-refresh" title="重新生成">${icon('refresh')}</button>
          <button class="icon-btn" data-action="gen-copy" title="复制">${icon('copy')}</button>
        </div>
        <div class="gen-meter">
          <span class="strength" id="genStrength" data-score="4"><span class="strength-bars"><i></i><i></i><i></i><i></i></span></span>
          <span id="genMeta"></span>
        </div>
        <div class="gen-opts">
          <div class="range-row">
            <span class="field-label" style="width:52px">长度</span>
            <input type="range" id="genLen" min="8" max="48" value="20" />
            <span class="range-val" id="genLenVal">20</span>
          </div>
          <div class="check-grid">
            <label class="check"><input type="checkbox" id="optLower" checked />小写字母 a-z</label>
            <label class="check"><input type="checkbox" id="optUpper" checked />大写字母 A-Z</label>
            <label class="check"><input type="checkbox" id="optDigits" checked />数字 0-9</label>
            <label class="check"><input type="checkbox" id="optSymbols" checked />符号 !@#$%</label>
            <label class="check"><input type="checkbox" id="optAmbiguous" checked />排除易混淆字符</label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-action="close-modal">关闭</button>
        <button class="btn primary" data-action="gen-use">使用此密码</button>
      </div>`,
    {
      onMount(m) {
        const text = m.querySelector('#genText');
        const meta = m.querySelector('#genMeta');
        const strengthEl = m.querySelector('#genStrength');
        let current = '';

        const refresh = async () => {
          const res = await api.generatePassword(options);
          if (!res.ok) return;
          current = res.data.password;
          text.textContent = current;
          const info = res.data.strength;
          strengthEl.dataset.score = String(info.score);
          meta.textContent = `${info.label} · 约 ${info.bits} bit · ${current.length} 位`;
        };

        const bind = (selector, key, isNumber) => {
          const el = m.querySelector(selector);
          el.addEventListener(isNumber ? 'input' : 'change', () => {
            options[key] = isNumber ? Number(el.value) : el.checked;
            if (isNumber) m.querySelector('#genLenVal').textContent = el.value;
            if (!options.lower && !options.upper && !options.digits && !options.symbols) {
              el.checked = true;
              options[key] = true;
              toast('至少保留一种字符集', 'error');
            }
            refresh();
          });
        };
        bind('#genLen', 'length', true);
        bind('#optLower', 'lower');
        bind('#optUpper', 'upper');
        bind('#optDigits', 'digits');
        bind('#optSymbols', 'symbols');
        bind('#optAmbiguous', 'excludeAmbiguous');

        m.querySelector('[data-action="gen-refresh"]').addEventListener('click', refresh);
        m.querySelector('[data-action="gen-copy"]').addEventListener('click', () => copyValue(current, { sensitive: true, label: '密码已复制' }));
        m.querySelector('[data-action="gen-use"]').addEventListener('click', () => {
          if (onUse) {
            onUse(current);
            closeModal();
          } else {
            copyValue(current, { sensitive: true, label: '密码已复制到剪贴板' });
          }
        });

        refresh();
      },
    },
  );
  return modal;
}

function openSettings() {
  const s = state.settings;
  const minuteOptions = [1, 3, 5, 10, 30, 60, 120]
    .map((m) => `<option value="${m}" ${s.autoLockMinutes === m ? 'selected' : ''}>${m} 分钟</option>`)
    .join('');
  const clipOptions = [0, 15, 30, 60, 120]
    .map((v) => `<option value="${v}" ${s.clipboardClearSeconds === v ? 'selected' : ''}>${v === 0 ? '不自动清除' : v + ' 秒'}</option>`)
    .join('');
  const revealOptions = [0, 10, 20, 60]
    .map((v) => `<option value="${v}" ${s.revealSeconds === v ? 'selected' : ''}>${v === 0 ? '保持显示' : v + ' 秒'}</option>`)
    .join('');

  openModal(
    `${modalHeader('设置', '调整安全策略与数据管理方式')}
      <div class="modal-body" style="padding-bottom:20px">
        <div class="settings-group">
          <div class="settings-title">安全</div>
          <div class="setting-row">
            <div class="setting-text"><strong>自动锁定</strong><span>无操作超过该时长后清除内存中的密钥</span></div>
            <div class="setting-control">
              <select class="select" data-setting="autoLockMinutes">${minuteOptions}</select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><strong>剪贴板自动清除</strong><span>仅当剪贴板内容仍是该密码时才清除</span></div>
            <div class="setting-control">
              <select class="select" data-setting="clipboardClearSeconds">${clipOptions}</select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><strong>密码显示时长</strong><span>点击眼睛图标后自动重新掩码的时间</span></div>
            <div class="setting-control">
              <select class="select" data-setting="revealSeconds">${revealOptions}</select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><strong>主密码</strong><span>修改后会用新派生密钥整体重新加密</span></div>
            <div class="setting-control">
              <button class="btn sm" data-action="change-master">修改</button>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-title">数据</div>
          <div class="setting-row">
            <div class="setting-text"><strong>导入浏览器密码</strong><span>从 Chrome / Edge / Brave 或 CSV 合并账号</span></div>
            <div class="setting-control">
              <button class="btn sm" data-action="import-browser">导入</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><strong>加密备份</strong><span>导出当前仓库副本，可用同一主密码恢复</span></div>
            <div class="setting-control">
              <button class="btn sm" data-action="export">${icon('download')} 导出</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <strong>明文导出</strong>
              <span>导出为 CSV 或 JSON，可迁移到其他密码管理器。<b class="warn-inline">结果是明文，用完请删除</b></span>
            </div>
            <div class="setting-control">
              <button class="btn sm" data-action="export-plain" data-format="csv">CSV</button>
              <button class="btn sm" data-action="export-plain" data-format="json">JSON</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><strong>数据位置</strong><span>文件本身已加密，可直接复制到其他设备</span>
              <div class="path-box">${esc(state.vaultPath)}</div>
            </div>
            <div class="setting-control">
              <button class="btn sm" data-action="open-folder">打开</button>
            </div>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-title">危险操作</div>
          <div class="danger-zone">
            <div class="setting-row" style="border:none;padding:0">
              <div class="setting-text"><strong>清空密码库</strong><span>永久删除仓库文件与备份，无法恢复</span></div>
              <div class="setting-control">
                <button class="btn sm danger" data-action="wipe">清空</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn primary" data-action="close-modal">完成</button>
      </div>`,
    {
      onMount(modal) {
        $$('[data-setting]', modal).forEach((el) => {
          el.addEventListener('change', async () => {
            const key = el.dataset.setting;
            const value = Number(el.value);
            state.settings[key] = value;
            const res = await api.updateSettings({ [key]: value });
            if (res.ok) {
              applySnapshot(res.data.snapshot);
              renderDetail();
              toast('设置已保存');
            } else {
              toast(res.error.message, 'error');
            }
          });
        });
      },
    },
  );
}

/** 空仓库且从未提醒过时，问一次要不要从浏览器导入；记录写在加密仓库设置里 */
function maybePromptImport(snapshot) {
  if (!snapshot || state.settings.importPrompted) return;
  if ((snapshot.entries || []).length) return;
  setTimeout(() => {
    if (!state.unlocked || state.entries.length || state.settings.importPrompted) return;
    if ($('#modalRoot').children.length) return; // 已经在别的弹层里，不要叠一层
    promptImportOnFirstRun();
  }, 700);
}

function promptImportOnFirstRun() {
  state.settings.importPrompted = true;
  api.updateSettings({ importPrompted: true });

  openModal(
    `${modalHeader('把浏览器里的密码带进来？', '第一次使用，可以先合并已有账号，省去逐个手动添加')}
      <div class="modal-body">
        <ul class="onboard-list">
          <li>${icon('check')}<span>读取本机 Chrome / Edge / Brave 的密码库</span></li>
          <li>${icon('check')}<span>只在本机解密，不上传、不写临时文件</span></li>
          <li>${icon('check')}<span>按「域名 + 账号」去重，默认不覆盖已有密码</span></li>
        </ul>
        <p class="onboard-foot">Firefox 需要先在浏览器里导出 CSV，再从导入界面选择文件。</p>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-action="skip-onboard">以后再说</button>
        <button class="btn primary" data-action="start-onboard">现在导入</button>
      </div>`,
    {
      onMount(modal) {
        modal.querySelector('[data-action="skip-onboard"]').addEventListener('click', () => {
          closeModal();
          toast('稍后可在「设置 → 数据」里导入');
        });
        modal.querySelector('[data-action="start-onboard"]').addEventListener('click', () => {
          closeModal();
          setTimeout(openImport, 120);
        });
      },
    },
  );
}

function openImport() {
  openModal(
    `${modalHeader('导入浏览器密码', '点一下就好，其余自动完成')}
      <div class="modal-body">
        <div id="quickImport" class="quick-import">
          <div class="import-loading">正在找最近导出的 CSV…</div>
        </div>

        <div id="importResult"></div>
        <p class="form-error" id="importError" role="alert"></p>

        <div class="import-mode">
          <span class="field-label">重复账号</span>
          <label class="mode-opt"><input type="radio" name="impMode" value="skip" checked /> 跳过已有</label>
          <label class="mode-opt"><input type="radio" name="impMode" value="overwrite" /> 用导入的密码覆盖</label>
        </div>

        <details class="import-more">
          <summary>没自动找到？手动选文件 / 直接读浏览器</summary>

          <div class="import-divider"><span>直接读取浏览器密码库</span></div>
          <div id="importSources" class="import-list"><div class="import-loading">正在扫描本机浏览器…</div></div>
          <div id="importWarn"></div>

          <div class="import-divider"><span>手动选择 CSV</span></div>
          <button class="btn sm" data-action="pick-csv">选择 CSV 文件…</button>
          <div id="csvPreview"></div>

          <details class="import-steps">
            <summary>怎么让浏览器导出 CSV？</summary>
            <ol>
              <li><strong>Chrome</strong>：打开 <code>chrome://password-manager/settings</code> → 下载文件</li>
              <li><strong>Edge</strong>：打开 <code>edge://settings/passwords</code> → 右上角「…」→ 导出密码</li>
              <li><strong>Firefox</strong>：<code>about:logins</code> → 右上角「…」→ 导出登录信息</li>
            </ol>
            <p class="import-csv-hint">导出时会要求 Windows Hello 或账户密码，这是浏览器自己的确认。导出后回到这里点「一键导入」即可。</p>
          </details>
        </details>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="btn primary" data-action="close-modal">完成</button>
      </div>`,
    {
      wide: true,
      onMount(modal) {
        const quick = modal.querySelector('#quickImport');
        const list = modal.querySelector('#importSources');
        const warnBox = modal.querySelector('#importWarn');
        const resultBox = modal.querySelector('#importResult');
        const errorBox = modal.querySelector('#importError');
        const preview = modal.querySelector('#csvPreview');
        const csvButton = modal.querySelector('[data-action="pick-csv"]');
        let mode = 'skip';
        let csvToken = null;
        let discovered = null;

        const showError = (message) => {
          errorBox.textContent = message || '';
          errorBox.classList.toggle('show', !!message);
        };

        const showResult = (stats, prefix = '') => {
          const parts = [`新增 ${stats.added} 条`];
          if (stats.updated) parts.push(`更新 ${stats.updated} 条`);
          if (stats.skipped) parts.push(`跳过 ${stats.skipped} 条`);
          if (stats.appBound) parts.push(`${stats.appBound} 条需改用 CSV`);
          if (stats.failed && !stats.appBound) parts.push(`${stats.failed} 条无法解密`);
          const warn = stats.appBound
            ? `<div class="import-warn"><strong>这些条目受应用绑定加密保护</strong><span>Chrome 127+ / Edge 127+ 的机制，只有浏览器自己能解密。请用「导出密码」生成 CSV 后再导入。</span></div>`
            : '';
          resultBox.innerHTML = `<div class="import-result">${icon('check')}<span>${esc(prefix)}${parts.join(' · ')}</span></div>${warn}`;
        };

        /** 渲染一键导入卡片 */
        const renderQuick = async () => {
          const res = await api.discoverCsv();
          if (!res.ok) {
            quick.innerHTML = `<div class="import-empty">查找失败：${esc(res.error.message)}</div>`;
            return;
          }
          discovered = res.data;

          const files = Array.isArray(discovered.files) && discovered.files.length
            ? discovered.files
            : discovered.file
              ? [discovered.file]
              : [];
          if (!files.length) {
            quick.innerHTML = `
              <div class="import-empty">
                <strong>还没找到 CSV 文件</strong>
                <span>先在浏览器里导出一次密码（下面有步骤），然后点这里重新查找。</span>
                <button class="btn sm" data-action="rescan-csv">重新查找</button>
              </div>`;
            return;
          }

          const stale = !discovered.confident;
          const totalSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
          const newest = files[0];
          const ageNote = stale
            ? `<span class="import-stale">这些文件是 ${esc(newest.ageLabel)}的，可能不是刚导出的</span>`
            : `<span class="import-fresh">${esc(newest.ageLabel)}导出</span>`;

          // 单个文件时显示文件名；多个时显示「N 个文件」并列出名字
          const headline =
            files.length === 1
              ? `<div class="quick-name">${esc(files[0].name)}</div>`
              : `<div class="quick-name">${files.length} 个文件</div>
                 <ul class="quick-filelist">
                   ${files.map((f) => `<li>${esc(f.name)}</li>`).join('')}
                 </ul>`;

          const buttonText = files.length === 1 ? '一键导入' : `一键导入这 ${files.length} 个`;

          quick.innerHTML = `
            <div class="quick-card">
              <div class="quick-main">
                <div class="quick-icon">${icon('download')}</div>
                <div class="quick-text">
                  ${headline}
                  <div class="quick-meta">${ageNote} · ${formatSize(totalSize)}${
                    files.length > 1 ? ` · 合计 ${files.length} 个` : ''
                  }</div>
                </div>
              </div>
              <button class="btn primary" data-action="quick-import">${buttonText}</button>
            </div>
            <p class="quick-hint">会把这 ${files.length} 个文件合并导入，按「域名 + 账号」去重。</p>`;

          if (discovered.truncated) {
            quick.insertAdjacentHTML(
              'beforeend',
              `<p class="quick-hint-text">文件较多，只导入最近 ${files.length} 个。</p>`,
            );
          }
        };

        modal.addEventListener('change', (event) => {
          if (event.target.name === 'impMode') {
            mode = event.target.value;
          }
        });

        modal.addEventListener('click', async (event) => {
          const button = event.target.closest('[data-action]');
          if (!button) return;
          const action = button.dataset.action;

          if (action === 'rescan-csv') {
            quick.innerHTML = '<div class="import-loading">正在找最近导出的 CSV…</div>';
            await renderQuick();
            return;
          }

          if (action === 'quick-import') {
            const targets =
              discovered && Array.isArray(discovered.files) && discovered.files.length
                ? discovered.files
                : discovered && discovered.file
                  ? [discovered.file]
                  : [];
            if (!targets.length) return;

            showError('');
            button.disabled = true;
            button.textContent = '导入中…';

            // 多文件合并成一次导入，保证去重和原子写入只在一次 save 里发生
            const res = await api.importCsvFiles(
              targets.map((f) => f.path),
              mode,
            );

            if (!res.ok) {
              button.disabled = false;
              button.textContent = targets.length > 1 ? `一键导入这 ${targets.length} 个` : '一键导入';
              showError(res.error.message);
              return;
            }

            applySnapshot(res.data.snapshot);
            renderAll();
            showResult(res.data.stats, targets.length > 1 ? `${res.data.fileCount} 个文件：` : `${res.data.fileName}：`);
            toast(`已导入：新增 ${res.data.stats.added} 条`);

            // 单个文件读取出错时明确告诉用户，不要静默跳过
            const failed = (res.data.perFile || []).filter((f) => f.error);
            if (failed.length) {
              showError(`${failed.length} 个文件读取失败：${failed.map((f) => f.name).join('、')}`);
            }

            // 恢复按钮，并把主操作换成「删掉明文 CSV」
            button.disabled = false;
            button.textContent = '再导入一次';
            button.classList.remove('primary');

            // 把文件名旁的「N 分钟前导出」换成导入结果，避免误导
            const metaEl = modal.querySelector('.quick-meta');
            if (metaEl) {
              metaEl.innerHTML = `<span class="import-fresh">已导入 · 新增 ${res.data.stats.added} 条</span>`;
            }

            const after = modal.querySelector('.quick-hint');
            if (after) {
              const ok = res.data.filePaths || [];
              const label = ok.length > 1 ? `删掉这 ${ok.length} 个 CSV（明文文件）` : '删掉这个 CSV（明文文件）';
              after.innerHTML = ok.length
                ? `<button class="btn sm" data-action="discard-csv" data-paths="${esc(JSON.stringify(ok))}">${label}</button>
                   <span class="quick-hint-text">留着也行，但它们是未加密的。</span>`
                : '<span class="quick-hint-text">文件已不在原位，无需删除。</span>';
            }
            return;
          }

          if (action === 'discard-csv') {
            let paths = [];
            if (button.dataset.paths) {
              try {
                paths = JSON.parse(button.dataset.paths);
              } catch {
                paths = [];
              }
            } else if (button.dataset.path) {
              paths = [button.dataset.path];
            }
            const res = await api.discardCsv(paths);
            if (res.ok && res.data.removed > 0) {
              button.disabled = true;
              button.textContent = res.data.total > 1 ? `已删除 ${res.data.removed} 个` : '已删除';
              toast(res.data.total > 1 ? `已删除 ${res.data.removed} 个明文 CSV` : '明文 CSV 已删除');
            } else if (res.ok) {
              button.textContent = '文件已不存在';
              button.disabled = true;
            } else {
              showError(res.error.message);
            }
            return;
          }

          if (action === 'focus-csv') {
            // 折叠区里的「导出步骤」：展开兜底区并滚到导出说明
            const more = modal.querySelector('.import-more');
            if (more) more.open = true;
            const steps = modal.querySelector('.import-steps');
            if (steps) steps.open = true;
            (steps || more)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
          }

          if (action === 'import-profile') {
            showError('');
            const label = button.dataset.label || '';
            button.disabled = true;
            button.textContent = '导入中…';
            const res = await api.importBrowser(button.dataset.id, button.dataset.dir, mode);
            button.disabled = false;
            button.textContent = '导入';
            if (!res.ok) {
              showError(res.error.message);
              return;
            }
            applySnapshot(res.data.snapshot);
            renderAll();
            showResult(res.data.stats, label ? `${label}：` : '');
            toast('浏览器密码已导入');
            return;
          }

          if (action === 'pick-csv') {
            showError('');
            csvButton.disabled = true;
            const res = await api.pickCsv();
            csvButton.disabled = false;
            if (!res.ok) {
              showError(res.error.message);
              return;
            }
            if (res.data.canceled) return;
            csvToken = res.data.token;
            const { count, skippedRows, fileName } = res.data;
            preview.innerHTML = `<div class="import-result">
              <span>${esc(fileName)}：读取 ${count} 条${skippedRows ? `，忽略 ${skippedRows} 行` : ''}</span>
              <button class="btn sm" data-action="import-csv">导入这 ${count} 条</button>
            </div>`;
            return;
          }

          if (action === 'import-csv') {
            if (!csvToken) return;
            showError('');
            button.disabled = true;
            button.textContent = '导入中…';
            const res = await api.importCsv(csvToken, mode);
            if (!res.ok) {
              button.disabled = false;
              button.textContent = '重试';
              showError(res.error.message);
              return;
            }
            csvToken = null;
            preview.innerHTML = '';
            applySnapshot(res.data.snapshot);
            renderAll();
            showResult(res.data.stats, `${res.data.fileName}：`);
            toast('CSV 已导入');
          }
        });

        // 一键导入卡片先渲染
        renderQuick();

        // 浏览器扫描沿用原逻辑
        (async () => {
          const res = await api.scanBrowsers();
          if (!res.ok) {
            list.innerHTML = '<div class="import-empty">扫描失败</div>';
            showError(res.error.message);
            return;
          }
          const sources = res.data.sources || [];
          if (!sources.length) {
            list.innerHTML = '<div class="import-empty">没有检测到 Chrome / Edge / Brave 的密码库</div>';
            return;
          }

          let boundTotal = 0;
          list.innerHTML = sources
            .flatMap((source) =>
              source.profiles.map((profile) => {
                const color = colorFor(source.name);
                const bound = Number(profile.appBound) || 0;
                const importable =
                  profile.importable == null
                    ? Math.max(0, (profile.count || 0) - bound)
                    : Number(profile.importable);
                boundTotal += bound;

                let meta;
                if (profile.count < 0) meta = '无法读取，可关闭浏览器后再试';
                else if (bound && !importable) meta = `${profile.count} 条 · 全部需用 CSV 导出`;
                else if (bound) meta = `${profile.count} 条（${bound} 条需 CSV）`;
                else meta = `${profile.count} 条`;

                const control =
                  importable > 0
                    ? `<button class="btn sm" data-action="import-profile" data-id="${esc(source.id)}" data-dir="${esc(profile.dir)}" data-label="${esc(source.name)}">导入</button>`
                    : bound > 0
                      ? `<button class="btn sm" data-action="focus-csv">导出步骤</button>`
                      : `<button class="btn sm" disabled>无可导入</button>`;

                return `<div class="import-source">
                  <div class="import-source-icon" style="--avatar:${color.fg};--avatar-bg:${color.bg}">${esc(source.name[0])}</div>
                  <div class="import-source-main">
                    <strong>${esc(source.name)}</strong>
                    <span>${esc(profile.label)} · ${meta}</span>
                  </div>
                  ${control}
                </div>`;
              }),
            )
            .join('');

          if (boundTotal) {
            warnBox.innerHTML = `<div class="import-warn"><strong>${boundTotal} 条密码受应用绑定加密保护</strong><span>Chrome 127+ / Edge 127+ 默认开启，只有浏览器自己能解密。请用「导出密码」生成 CSV，再用下方导入。</span></div>`;
          }
        })();
      },
    },
  );
}

function openChangeMaster() {
  openModal(
    `${modalHeader('修改主密码', '原密码用于验证身份，新密码将重新派生密钥')}
      <form id="masterForm">
        <div class="modal-body">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">当前主密码</span>
              <input class="input" type="password" id="oldMaster" autocomplete="off" />
            </label>
            <label class="field">
              <span class="field-label">新主密码</span>
              <input class="input" type="password" id="newMaster" autocomplete="off" />
              <span class="field-hint" id="newMasterHint">至少 8 位</span>
            </label>
            <label class="field">
              <span class="field-label">确认新主密码</span>
              <input class="input" type="password" id="newMaster2" autocomplete="off" />
            </label>
          </div>
          <p class="form-error" id="masterError" role="alert"></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-action="close-modal">取消</button>
          <button type="submit" class="btn primary" id="masterSubmit">确认修改</button>
        </div>
      </form>`,
    {
      onMount(modal) {
        const newInput = modal.querySelector('#newMaster');
        const hint = modal.querySelector('#newMasterHint');
        newInput.addEventListener('input', () => {
          const info = strengthOf(newInput.value);
          hint.textContent = newInput.value ? `强度：${info.label} · ${info.bits} bit` : '至少 8 位';
          hint.style.color = info.score && info.score <= 1 ? 'var(--danger)' : '';
        });
        modal.querySelector('#masterForm').addEventListener('submit', async (event) => {
          event.preventDefault();
          const err = modal.querySelector('#masterError');
          const oldPw = modal.querySelector('#oldMaster').value;
          const newPw = newInput.value;
          const confirmPw = modal.querySelector('#newMaster2').value;
          const fail = (msg) => {
            err.textContent = msg;
            err.classList.add('show');
          };
          if (!oldPw) return fail('请输入当前主密码');
          if (newPw.length < 8) return fail('新主密码至少 8 位');
          if (newPw !== confirmPw) return fail('两次输入的新密码不一致');
          if (newPw === oldPw) return fail('新密码不能与旧密码相同');
          const button = modal.querySelector('#masterSubmit');
          button.disabled = true;
          button.textContent = '重新加密中…';
          const res = await api.changeMaster(oldPw, newPw);
          button.disabled = false;
          button.textContent = '确认修改';
          if (!res.ok) return fail(res.error.code === 'INVALID_PASSWORD' ? '当前主密码不正确' : res.error.message);
          closeModal();
          toast('主密码已更新，仓库已重新加密');
        });
      },
    },
  );
}

async function deleteEntry(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  const confirmed = await confirmDialog({
    title: '删除条目',
    message: `确定删除 <strong>${esc(entry.title)}</strong> 吗？该操作会立即重写加密文件，无法撤销。`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  const res = await api.deleteEntry(id);
  if (!res.ok) return toast(res.error.message, 'error');
  applySnapshot(res.data);
  if (state.selectedId === id) state.selectedId = null;
  renderAll();
  toast('条目已删除');
}

async function addCategory() {
  openModal(
    `${modalHeader('新增分类', '分类会保存在加密仓库中')}
      <form id="catForm">
        <div class="modal-body">
          <label class="field">
            <span class="field-label">分类名称</span>
            <input class="input" id="catName" maxlength="40" placeholder="例如：服务器" />
          </label>
          <p class="form-error" id="catError" role="alert"></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-action="close-modal">取消</button>
          <button type="submit" class="btn primary">添加</button>
        </div>
      </form>`,
    {
      onMount(modal) {
        modal.querySelector('#catForm').addEventListener('submit', async (event) => {
          event.preventDefault();
          const value = modal.querySelector('#catName').value.trim();
          if (!value) {
            const err = modal.querySelector('#catError');
            err.textContent = '请输入分类名称';
            err.classList.add('show');
            return;
          }
          const res = await api.addCategory(value);
          if (!res.ok) return toast(res.error.message, 'error');
          applySnapshot(res.data);
          state.category = value;
          closeModal();
          renderAll();
          toast('分类已添加');
        });
      },
    },
  );
}

/* ---------------- 事件绑定 ---------------- */

document.addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle-password]');
  if (toggle) {
    const input = document.getElementById(toggle.dataset.togglePassword);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.innerHTML = icon(show ? 'eye-off' : 'eye');
    return;
  }

  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const entry = selectedEntry();

  switch (action) {
    case 'close-modal':
      closeModal();
      break;
    case 'select':
      if (el.dataset.id) selectEntry(el.dataset.id);
      break;
    case 'back':
      shell.classList.remove('detail-open');
      break;
    case 'new':
      openEditor(null);
      shell.classList.remove('drawer-open');
      break;
    case 'edit':
      if (entry) openEditor(entry);
      break;
    case 'delete':
      if (entry) deleteEntry(entry.id);
      break;
    case 'delete-entry': {
      const id = el.dataset.id || (entry && entry.id);
      closeModal();
      if (id) deleteEntry(id);
      break;
    }
    case 'open-url':
      if (entry && entry.url) {
        const res = await api.openExternal(entry.url);
        if (!res.ok) toast(res.error.message, 'error');
      }
      break;
    case 'copy-password': {
      const target = el.dataset.id ? state.entries.find((e) => e.id === el.dataset.id) : entry;
      if (target) copyValue(target.password, { sensitive: true, label: '密码已复制' });
      break;
    }
    case 'copy-username': {
      const target = state.entries.find((e) => e.id === el.dataset.id);
      if (target) copyValue(target.username, { label: '账号已复制' });
      break;
    }
    case 'copy-field': {
      if (!entry) break;
      const field = el.dataset.field;
      copyValue(entry[field], { label: field === 'url' ? '网址已复制' : '账号已复制' });
      break;
    }
    case 'toggle-reveal': {
      if (!entry) break;
      if (state.revealed.has(entry.id)) {
        clearReveal(entry.id);
      } else {
        state.revealed.add(entry.id);
        const seconds = state.settings.revealSeconds;
        if (seconds > 0) {
          clearTimeout(state.revealTimers.get(entry.id));
          state.revealTimers.set(
            entry.id,
            setTimeout(() => {
              state.revealed.delete(entry.id);
              state.revealTimers.delete(entry.id);
              renderDetail();
            }, seconds * 1000),
          );
        }
      }
      renderDetail();
      break;
    }
    case 'filter':
      state.category = el.dataset.category;
      shell.classList.remove('drawer-open');
      renderCategories();
      renderList();
      break;
    case 'generator':
      openGenerator();
      shell.classList.remove('drawer-open');
      break;
    case 'open-generator': {
      const input = $('#fPassword');
      const hint = $('#fPwHint');
      openGenerator({
        onUse(password) {
          if (!input) return;
          input.value = password;
          input.type = 'text';
          const info = strengthOf(password);
          if (hint) hint.textContent = `强度：${info.label} · 约 ${info.bits} bit 熵`;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
      });
      break;
    }
    case 'settings':
      openSettings();
      shell.classList.remove('drawer-open');
      break;
    case 'lock':
      await api.lock();
      resetToLock('manual');
      break;
    case 'change-master':
      openChangeMaster();
      break;
    case 'import-browser':
      openImport();
      break;
    case 'export': {
      const res = await api.exportBackup();
      if (!res.ok) toast(res.error.message, 'error');
      else if (!res.data.canceled) toast('备份已导出');
      break;
    }
    case 'export-plain': {
      const format = el.dataset.format === 'json' ? 'json' : 'csv';
      const confirmed = await confirmDialog({
        title: `导出为 ${format.toUpperCase()}？`,
        message: '导出的是明文，任何能读到该文件的人都能看到全部密码。建议迁移后立即删除，不要放在同步盘里。',
        confirmText: '仍要导出',
        danger: true,
      });
      if (!confirmed) break;
      const res = await api.exportPlain(format);
      if (!res.ok) toast(res.error.message, 'error');
      else if (!res.data.canceled) toast(`已导出 ${res.data.count} 条到 ${res.data.format.toUpperCase()}`);
      break;
    }
    case 'open-folder':
      await api.openDataFolder();
      break;
    case 'wipe': {
      const res = await api.wipe();
      if (!res.ok) {
        toast(res.error.message, 'error');
        break;
      }
      if (res.data.wiped) {
        state.exists = false;
        closeModal();
        resetToLock('wipe');
        setSetupMode(true);
        toast('密码库已删除');
      }
      break;
    }
    case 'drawer':
      shell.classList.toggle('drawer-open');
      break;
    case 'close-drawer':
      shell.classList.remove('drawer-open');
      break;
    case 'empty-reset':
      if (state.entries.length === 0) {
        openEditor(null);
      } else {
        state.query = '';
        state.category = 'all';
        $('#searchInput').value = '';
        $('#clearSearchBtn').hidden = true;
        renderCategories();
        renderList();
      }
      break;
  }
});

$('#newEntryBtn').addEventListener('click', () => openEditor(null));
$('#addCategoryBtn').addEventListener('click', addCategory);

$('#searchInput').addEventListener('input', (event) => {
  state.query = event.target.value;
  $('#clearSearchBtn').hidden = !state.query;
  renderList();
});

$('#clearSearchBtn').addEventListener('click', () => {
  state.query = '';
  $('#searchInput').value = '';
  $('#clearSearchBtn').hidden = true;
  renderList();
  $('#searchInput').focus();
});

$('#sortBtn').addEventListener('click', () => {
  state.sort = state.sort === 'updated' ? 'title' : 'updated';
  $('#sortBtn').title = state.sort === 'updated' ? '当前：最近更新 · 点击按名称排序' : '当前：按名称排序 · 点击按更新时间排序';
  renderList();
});

$('#entryList').addEventListener('dblclick', (event) => {
  if (event.target.closest('.entry-actions')) return;
  const row = event.target.closest('.entry');
  if (!row) return;
  const entry = state.entries.find((e) => e.id === row.dataset.id);
  if (entry) copyValue(entry.password, { sensitive: true, label: '密码已复制' });
});

$('#entryList').addEventListener('keydown', (event) => {
  const row = event.target.closest('.entry');
  if (!row) return;
  const list = visibleEntries();
  const index = list.findIndex((e) => e.id === row.dataset.id);
  const move = (id) => {
    selectEntry(id);
    requestAnimationFrame(() => document.querySelector('.entry.active')?.focus());
  };
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectEntry(row.dataset.id);
  } else if (event.key === 'ArrowDown' && index < list.length - 1) {
    event.preventDefault();
    move(list[index + 1].id);
  } else if (event.key === 'ArrowUp' && index > 0) {
    event.preventDefault();
    move(list[index - 1].id);
  }
});

/* ---------------- 快捷键与安全行为 ---------------- */

let lastTouch = 0;
function touchActivity() {
  const now = Date.now();
  if (now - lastTouch < 8000) return;
  lastTouch = now;
  api.touch();
}
document.addEventListener('pointerdown', touchActivity, { passive: true });
document.addEventListener('keydown', touchActivity, { passive: true });

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const modalOpen = $('#modalRoot').children.length > 0;
  if (modalOpen && event.key !== 'Escape') return;
  if (mod && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    if (state.unlocked) $('#searchInput').focus();
    return;
  }
  if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    if (state.unlocked) openEditor(null);
    return;
  }
  if (mod && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    if (state.unlocked) {
      api.lock().then(() => resetToLock('manual'));
    }
    return;
  }
  if (mod && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    if (state.unlocked) openGenerator();
    return;
  }
  if (event.key === 'Escape') {
    if ($('#modalRoot').children.length) {
      closeModal();
      return;
    }
    if (shell.classList.contains('detail-open')) {
      shell.classList.remove('detail-open');
      return;
    }
    if (state.query) {
      state.query = '';
      $('#searchInput').value = '';
      $('#clearSearchBtn').hidden = true;
      renderList();
    }
  }
});

api.onLocked(({ reason }) => {
  resetToLock(reason === 'idle' ? 'idle' : 'manual');
});

api.onCommand(({ name }) => {
  if (name === 'export' && state.unlocked) {
    api.exportBackup().then((res) => {
      if (res.ok && !res.data.canceled) toast('备份已导出');
    });
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 980) shell.classList.remove('detail-open', 'drawer-open');
});

/* ---------------- 启动 ---------------- */

(async function boot() {
  const res = await api.status();
  if (res.ok) {
    state.exists = res.data.exists;
    state.vaultPath = res.data.path || '';
    state.version = res.data.version || '';
  }
  renderDetail.lastId = null;
  setSetupMode(!state.exists);
  $('#sortBtn').title = '当前：最近更新 · 点击按名称排序';
  renderDetail();
  setTimeout(() => masterInput.focus(), 260);
})();
