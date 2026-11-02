// 一次性填充授权的状态机（纯逻辑，不依赖 chrome.* API）。
//
// 抽出来的原因：Service Worker 里的逻辑没法在 node 里直接测（没有 chrome 对象），
// 而"授权是否真的只能用一次"恰恰是最需要被测住的东西。
// SW 引用**同一份**代码，不是复制品。
//
// # 状态机
//
// ```text
//   (无) --issue--> issued
//   issued --beginRedeem(校验通过)--> consuming
//   consuming --consume--> (删除)
//   任意 --invalidate / 过期--> (删除)
// ```
//
// 不变式：
// - 只有 `issued` 能被 `beginRedeem`；一旦进入 `consuming` 就不可能再兑换
//   → 重放与并发第二次兑换必然失败
// - 任何校验失败都立即删除，不留给攻击者重试的机会

/**
 * @typedef {object} AuthRecord
 * @property {'issued'|'consuming'} state
 * @property {number} tabId
 * @property {number} frameId
 * @property {string} origin
 * @property {string} entryId
 * @property {string} username
 * @property {number} expiresAt
 */

export class AuthStore {
  /**
   * @param {() => number} now 取当前时间（毫秒）。注入是为了测试过期。
   * @param {number} ttlMs 有效期
   */
  constructor(now, ttlMs) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, AuthRecord>} */
    this.records = new Map();
  }

  /** 清理过期项，返回清理数量。 */
  sweep() {
    const t = this.now();
    let n = 0;
    for (const [k, r] of this.records) {
      if (r.expiresAt <= t) {
        this.records.delete(k);
        n += 1;
      }
    }
    return n;
  }

  /**
   * 签发授权。
   * @param {string} nonce 由调用方用 CSPRNG 生成
   * @param {Omit<AuthRecord,'state'|'expiresAt'>} fields
   */
  issue(nonce, fields) {
    if (typeof nonce !== 'string' || !nonce) throw new Error('nonce required');
    if (this.records.has(nonce)) throw new Error('nonce collision');
    this.records.set(nonce, {
      state: 'issued',
      tabId: fields.tabId,
      frameId: fields.frameId,
      origin: fields.origin,
      entryId: fields.entryId,
      username: fields.username || '',
      expiresAt: this.now() + this.ttlMs,
    });
    return this.records.get(nonce);
  }

  /**
   * 校验并推进到 consuming。
   *
   * 任一项不符 → 删除记录并返回 null（**不留重试机会**）。
   *
   * @param {string} nonce
   * @param {{tabId:number, frameId:number, origin:string, entryId:string}} claimed
   *   调用方声明的绑定值。origin 必须是已规范化的字符串。
   * @returns {AuthRecord|null}
   */
  beginRedeem(nonce, claimed) {
    this.sweep();
    const r = this.records.get(nonce);
    if (!r) return null;
    if (r.state !== 'issued') {
      // 已经在兑换中或已消费：这是重放/并发
      this.records.delete(nonce);
      return null;
    }
    if (r.expiresAt <= this.now()) {
      this.records.delete(nonce);
      return null;
    }
    if (
      r.tabId !== claimed.tabId ||
      r.frameId !== claimed.frameId ||
      r.origin !== claimed.origin ||
      r.entryId !== claimed.entryId
    ) {
      this.records.delete(nonce);
      return null;
    }
    r.state = 'consuming';
    return r;
  }

  /** 兑换成功后的消费。 */
  consume(nonce) {
    this.records.delete(nonce);
  }

  /** 校验失败/异常时作废。 */
  invalidate(nonce) {
    this.records.delete(nonce);
  }

  /** 某个 tab 的全部授权作废（tab 关闭）。 */
  invalidateTab(tabId) {
    let n = 0;
    for (const [k, r] of this.records) {
      if (r.tabId === tabId) {
        this.records.delete(k);
        n += 1;
      }
    }
    return n;
  }

  /** 主框架导航后作废该 tab 的全部授权。 */
  invalidateNavigation(tabId, frameId) {
    if (frameId !== 0) return 0;
    return this.invalidateTab(tabId);
  }

  /** 全部作废（断连、锁定、SW 重启）。 */
  clear() {
    const n = this.records.size;
    this.records.clear();
    return n;
  }

  size() {
    return this.records.size;
  }

  peek(nonce) {
    return this.records.get(nonce) || null;
  }
}
