// Service Worker —— 只做三件事：建宿主、挂消息入口、让宿主可被复用。
//
// # 这个文件刻意保持很薄
//
// 阶段 2.7.4 之前，这里是一个 378 行的单体：Native 端口、授权状态机、
// 消息路由、业务逻辑全在一起。要继续加十几个功能，有两条路：
//
//   A. 继续往这里加 → 半年后没人敢改，权限也说不清谁用了什么
//   B. 拆成模块，SW 只负责装配 → 加功能只需写一个模块文件 + 一行注册
//
// 选了 B。这个文件从 378 行降到 50 行左右，**行为一行没改**——
// 每条不变式都搬进了 lib/modules/vault.js，并用真实 Chrome 验收做回归网。
//
// # 三条不变式（改任何模块前请先读）
//
//   1. 只有 lib/host.js 能 `connectNative`。content script 永远拿不到端口。
//   2. 密码只在模块的局部变量里短暂存在，绝不写 storage、绝不进日志。
//   3. 填充授权是一次性、短时效、绑定 tab/frame/origin/entry 的**状态机**，
//      不是"创建完就删掉"的摆设。
//
// # 关于 async 宿主
//
// 建宿主需要探测存储后端（真写一次再删），所以是异步的。
// 但消息监听器**必须同步注册**——MV3 的 SW 可能因为这条消息才被唤醒，
// 晚一步注册就会漏掉。两者用"同步登记监听器 + 首次消息时等待宿主就绪"解决。

import { createHost } from '../lib/host.js';

/**
 * 宿主实例的**单例**。
 *
 * 为什么挂到 `globalThis`：MV3 的 SW 会被浏览器随时回收再唤醒，
 * 每次唤醒都是**新的模块实例**。挂到 globalThis 让同一代 SW 内的多次消息
 * 复用同一个宿主（否则每次消息都新建一份 auths，授权根本存不住）。
 * SW 真正重启时 globalThis 也是新的，两者语义一致。
 */
const HOST_KEY = '__keynestHostPromise';

/** 取宿主；首次调用时开始构建，返回同一个 Promise。 */
function host() {
  if (!globalThis[HOST_KEY]) {
    globalThis[HOST_KEY] = createHost(chrome).catch((e) => {
      // 建宿主失败要让后续消息能重试，而不是永久缓存一个 rejected promise。
      // 典型场景：存储首次访问抛错、某个模块注册失败。
      globalThis[HOST_KEY] = null;
      throw e;
    });
  }
  return globalThis[HOST_KEY];
}

// ---- 消息入口 ----
//
// **必须在模块顶层同步注册**：MV3 的 SW 可能因为这条消息才被唤醒，
// 监听器晚一步注册就会漏掉唤醒事件。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  host()
    .then((h) => h.onMessage(msg, sender, sendResponse))
    .catch((e) => {
      // 宿主都没起来：回一个稳定错误码，别让调用方等到超时。
      // 只回 code，不带 e.message（可能含路径/策略细节）。
      sendResponse({ ok: false, error: 'HOST_INIT_FAILED' });
    });
  // 无论如何都要返回 true：上面的 .then 是异步的，
  // 返回 false 会让 Chrome 立刻关掉消息通道，sendResponse 就无效了。
  return true;
});
