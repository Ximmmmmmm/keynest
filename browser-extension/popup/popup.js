// Popup 入口 —— 现在只有三件事：建宿主、注册面板、渲染。
//
// # 这个文件刻意保持薄
//
// 之前的版本同时做：查标签页、问 KeyNest 状态、渲染列表、处理点击、
// 判断广告模块是否启用、渲染广告过滤块。加第三个功能就会变成一堆 if。
//
// 现在每块 UI 是一个**面板**（popup/panels.js），这个文件只负责装配。
// 面板自己知道「我要什么数据、我长什么样、点了做什么」。
//
// # 面板系统的三条保证
//
//   1. 单个面板抛错不影响其他（PanelHost 捕获并在原位显示一行小字）
//   2. 模块未启用的面板整块跳过，连容器都不创建
//   3. 按 order 排序，顺序稳定可预测
//
// # 它是唯一能发起填充的上下文
//
// 用户必须**在这里点一下**。网页无法点击 popup，
// content script 也没有权限伪造这类消息。

import { PanelHost } from './panel-host.js';
import { createAdblockPanel, createFillPanel } from './panels.js';

/** 发消息给 SW，并把异常统一成 {ok:false, error}。 */
async function send(type, msg) {
  try {
    return await chrome.runtime.sendMessage({ type, ...(msg || {}) });
  } catch (e) {
    // 扩展被重载、SW 正在启动等都可能抛。
    // 返回结构化错误而不是抛出去：面板代码不该为每个调用写 try/catch。
    return { ok: false, error: 'SEND_FAILED' };
  }
}

const els = {
  status: document.getElementById('status'),
  panels: document.getElementById('panels'),
  error: document.getElementById('error'),
  refresh: document.getElementById('refresh'),
  openOptions: document.getElementById('open-options'),
};

function setError(text) {
  if (!text) {
    els.error.classList.add('hidden');
    els.error.textContent = '';
    return;
  }
  els.error.textContent = text;
  els.error.classList.remove('hidden');
}

/** 当前标签页。没有 tabs 权限时 `tab.url` 是 undefined —— 这不是错误。 */
let currentTab = null;

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;
  } catch {
    currentTab = null;
  }

  const host = new PanelHost({
    root: els.panels,
    send,
    setError,
  });

  host.register(createFillPanel({ getTabId: () => (currentTab ? currentTab.id : null) }));
  host.register(createAdblockPanel({ getTabUrl: () => (currentTab ? currentTab.url : null) }));

  await refreshStatus();
  await host.renderAll();

  els.refresh.addEventListener('click', async () => {
    setError(null);
    await refreshStatus();
    await host.renderAll();
  });

  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

/** 顶部状态徽标：只反映 KeyNest 本体是否在线/解锁，不反映任何模块。 */
async function refreshStatus() {
  els.status.textContent = '检查中…';
  els.status.className = 'badge';

  const res = await send('status');
  if (!res || !res.ok) {
    els.status.textContent = '未连接';
    els.status.className = 'badge bad';
    return;
  }
  if (res.data && res.data.locked) {
    els.status.textContent = '已锁定';
    els.status.className = 'badge bad';
    return;
  }
  els.status.textContent = '已解锁';
  els.status.className = 'badge ok';
}

init();
