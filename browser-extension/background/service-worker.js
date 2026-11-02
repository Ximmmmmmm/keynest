// Service Worker —— 现在只做三件事：建宿主、挂消息入口、暴露给测试。
//
// # 这个文件刻意保持很薄
//
// 阶段 2.7.4 之前，这里是一个 378 行的单体：Native 端口、授权状态机、
// 消息路由、业务逻辑全在一起。要继续加十几个功能，有两条路：
//
//   A. 继续往这里加 → 半年后没人敢改，权限也说不清谁用了什么
//   B. 拆成模块，SW 只负责装配 → 加功能只需写一个模块文件 + 一行注册
//
// 选了 B。这个文件从 378 行降到 60 行左右，**行为一行没改**——
// 每条不变式都搬进了 lib/modules/vault.js，并用阶段 2.7.4 的
// 17 项真实 Chrome 验收做回归网。
//
// # 三条不变式（改任何模块前请先读）
//
//   1. 只有 lib/host.js 能 `connectNative`。content script 永远拿不到端口。
//   2. 密码只在模块的局部变量里短暂存在，绝不写 storage、绝不进日志。
//   3. 填充授权是一次性、短时效、绑定 tab/frame/origin/entry 的**状态机**，
//      不是"创建完就删掉"的摆设。

import { createHost } from '../lib/host.js';

/**
 * 宿主实例。
 *
 * 为什么挂到 `globalThis`：MV3 的 SW 会被浏览器随时回收再唤醒，
 * 每次唤醒都是**新的模块实例**。挂到 globalThis 让同一代 SW 内的多次消息
 * 复用同一个宿主（否则每次消息都新建一份 auths，授权根本存不住）。
 * SW 真正重启时 globalThis 也是新的，两者语义一致。
 */
const HOST_KEY = '__keynestHost';

function host() {
  if (!globalThis[HOST_KEY]) {
    globalThis[HOST_KEY] = createHost(chrome);
  }
  return globalThis[HOST_KEY];
}

// ---- 消息入口 ----
//
// **必须在模块顶层同步注册**：MV3 的 SW 可能因为这条消息才被唤醒，
// 监听器晚一步注册就会漏掉唤醒事件。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  return host().onMessage(msg, sender, sendResponse);
});
