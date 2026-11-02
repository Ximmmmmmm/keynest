// 设置页：把模块注册表直接渲染出来。
//
// # 这个页面存在的意义
//
// 之前的 popup 只有一个"填充"功能，用户看不到扩展到底拿了自己多少权限。
// 随着功能变多（广告过滤要拦请求、阅读模式要改页面、截图要读屏幕），
// "这个扩展能做什么"必须变成用户**能看见**的东西，而不是埋在 manifest 里。
//
// 所以这个页面做三件事：
//   1. 列出所有模块，以及每个模块**申请了哪些浏览器能力**
//   2. 允许开关非核心模块（核心模块显示为不可关闭并说明原因）
//   3. 显示"模块实际需要 vs manifest 实际声明"的差异——这是给开发者的，
//      但用户看到也无妨：它证明权限没有偷偷膨胀
//
// # 它读不到什么
//
// 读不到任何密码、密钥、条目内容。`modules.list` 只回模块元数据与配置默认值。

const els = {
  list: document.getElementById('modules'),
  summary: document.getElementById('summary'),
  permDiff: document.getElementById('perm-diff'),
  error: document.getElementById('error'),
  hint: document.getElementById('hint'),
};

/** 能力名 → 用户能看懂的中文。没列出的原样显示。 */
const CAPABILITY_LABEL = {
  nativeMessaging: '与本地钥巢通信',
  activeTab: '读取当前标签页地址',
  scripting: '向页面注入脚本',
  webNavigation: '感知页面跳转',
  tabs: '管理标签页',
  hostHttps: '访问 HTTPS 网站',
  declarativeNetRequest: '拦截网络请求',
  contentScript: '修改页面内容',
  extensionPages: '扩展自己的页面',
  notifications: '发送通知',
  contextMenus: '右键菜单',
  configStore: '保存设置（仅本地）',
  clipboardWrite: '写入剪贴板',
};

function showError(text) {
  if (!text) {
    els.error.classList.add('hidden');
    return;
  }
  els.error.textContent = text;
  els.error.classList.remove('hidden');
}

function label(cap) {
  return CAPABILITY_LABEL[cap] || cap;
}

/**
 * 某个模块的档位选择器。
 *
 * 只对声明了 `config.mode` 的模块渲染。这样设置页不需要知道
 * "广告过滤有档位"这种事——模块在 schema 里说了，页面就渲染。
 */
function renderModePicker(m) {
  const schema = (m.configSchema && m.configSchema.mode) || null;
  if (!schema || schema.type !== 'enum') return null;
  const current = m.config && m.config.mode;

  const wrap = document.createElement('div');
  wrap.className = 'mode';

  const label = document.createElement('span');
  label.className = 'mode-label';
  label.textContent = '过滤强度';

  const select = document.createElement('select');
  const MODE_TEXT = {
    off: '关闭过滤',
    basic: '基础（只拦专用广告/跟踪域名）',
    strict: '严格（追加跟踪器与参数剔除）',
  };
  for (const v of schema.values || []) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = MODE_TEXT[v] || v;
    if (v === current) opt.selected = true;
    select.append(opt);
  }

  select.addEventListener('change', async () => {
    select.disabled = true;
    const res = await chrome.runtime.sendMessage({
      type: 'adblock.apply',
      mode: select.value,
    });
    select.disabled = false;
    if (!res || !res.ok) {
      showError(`切换过滤强度失败：${(res && res.error) || '未知错误'}`);
      return;
    }
    showError('');
    showHint(`已切换为「${MODE_TEXT[select.value] || select.value}」，规则数 ${res.rules}`);
  });

  wrap.append(label, select);
  return wrap;
}

/** 临时提示（不打断操作）。 */
function showHint(text) {
  els.hint.textContent = text;
  els.hint.classList.remove('hidden');
}

function renderModule(m, canToggle) {
  const card = document.createElement('article');
  card.className = 'module';

  const head = document.createElement('div');
  head.className = 'module-head';

  const name = document.createElement('h2');
  name.textContent = m.title;
  head.append(name);

  if (canToggle) {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = m.enabled;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      const res = await chrome.runtime.sendMessage({
        type: 'modules.set-enabled',
        id: m.id,
        enabled: cb.checked,
      });
      cb.disabled = false;
      if (!res || !res.ok) {
        cb.checked = !cb.checked; // 回滚 UI，不留下"看起来开了其实没开"
        showError(`切换失败：${(res && res.error) || '未知错误'}`);
        return;
      }
      showError('');
    });
    wrap.append(cb, document.createTextNode(m.enabled ? '已启用' : '已停用'));
    // 文案随状态更新
    cb.addEventListener('change', () => {
      wrap.lastChild.textContent = cb.checked ? '已启用' : '已停用';
    });
    head.append(wrap);
  } else {
    const tag = document.createElement('span');
    tag.className = 'badge-required';
    tag.textContent = '核心模块';
    head.append(tag);
  }

  const desc = document.createElement('p');
  desc.className = 'module-desc';
  desc.textContent = m.description || '（无说明）';

  const perms = document.createElement('ul');
  perms.className = 'perms';
  if (m.requires.length === 0) {
    const li = document.createElement('li');
    li.textContent = '不申请任何浏览器能力';
    perms.append(li);
  } else {
    for (const cap of m.requires) {
      const li = document.createElement('li');
      li.textContent = label(cap);
      perms.append(li);
    }
  }

  card.append(head, desc, perms);
  const picker = renderModePicker(m);
  if (picker) card.append(picker);
  return card;
}

async function refresh() {
  showError('');
  els.list.replaceChildren();

  const res = await chrome.runtime.sendMessage({ type: 'modules.list' });
  if (!res || !res.ok) {
    showError(`读取模块列表失败：${(res && res.error) || '未知错误'}`);
    return;
  }

  const mods = res.modules || [];
  els.summary.textContent = `共 ${mods.length} 个模块，其中 ${
    mods.filter((m) => m.enabled).length
  } 个启用。`;

  // 核心模块（vault / registry）不可关闭：关掉 vault 这个扩展就没有意义，
  // 关掉 registry 设置页会失去自我描述的能力。
  const CORE = new Set(['vault', 'registry']);
  for (const m of mods) {
    els.list.append(renderModule(m, !CORE.has(m.id)));
  }

  // 权限差异：给自己看，也给用户看
  const need = res.manifest || { permissions: [], hostPermissions: [] };
  const lines = [
    `模块实际需要：${need.permissions.length ? need.permissions.join('、') : '（无）'}`,
    `需要的站点范围：${need.hostPermissions.length ? need.hostPermissions.join('、') : '（无）'}`,
  ];
  els.permDiff.textContent = lines.join('\n');
}

refresh();
