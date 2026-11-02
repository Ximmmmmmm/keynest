// 极简 CDP 客户端（零依赖）。
//
// 为什么不用 puppeteer：本项目的验收只依赖浏览器自带能力，
// 引入一个会下载 Chromium 的重依赖，反而让「测试环境到底是什么」变得不确定。
// Node 22+ 自带 WebSocket，够用了。

import { setTimeout as sleep } from 'node:timers/promises';

export class Cdp {
  /**
   * @param {string} wsUrl 形如 ws://127.0.0.1:9222/devtools/browser/<id>
   */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
  }

  static async connect(wsUrl, { timeoutMs = 10000 } = {}) {
    const c = new Cdp(wsUrl);
    await c.#open(timeoutMs);
    return c;
  }

  #open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`CDP_CONNECT_FAILED: ${e?.message || 'error'}`));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          for (const fn of this.listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
        }
      });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  /** 发送一条命令。sessionId 为空时发给浏览器级 target。 */
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 轮询直到 fn() 返回真值，返回该真值；超时抛错。 */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}`);
}

/** 从 /json/version 取浏览器级 WebSocket 地址。 */
export async function browserWsUrl(port) {
  return waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (!r.ok) return null;
        const j = await r.json();
        return j.webSocketDebuggerUrl || null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 20000, label: 'chrome devtools endpoint' }
  );
}
