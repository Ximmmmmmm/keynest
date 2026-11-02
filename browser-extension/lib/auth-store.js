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
//   issued --claim(同步校验)--> validating      ← 认领权在此刻被独占
//   validating --confirm(浏览器侧校验通过)--> consuming
//   validating --abort(校验失败/异常)--> (删除)
//   consuming --consume--> (删除)
//   任意 --invalidate / 过期--> (删除)
// ```
//
// # 并发安全的关键
//
// `claim()` 是**同步**的，且是唯一能把状态从 `issued` 推进出去的入口。
// JavaScript 是单线程的，所以：
//
// ```js
// const rec = store.claim(nonce, claimed);   // 同步：100 个并发请求里只有 1 个拿到非 null
// if (!rec) return reject;                   // 其余 99 个在这里就被挡掉
// const tab = await chrome.tabs.get(...);    // 此时才 await
// ```
//
// 认领发生在任何 `await` **之前**，所以不存在"两个请求都读到 issued"的窗口。
//
// # 不可回退
//
// `validating` 不能回到 `issued`。校验失败只能 `abort()`（删除），
// 不存在"恢复成可再次兑换"的路径——这是防重放的根本。

/**
 * @typedef {object} AuthRecord
 * @property {'issued'|'validating'|'consuming'} state
 * @property {number} tabId
 * @property {number} frameId
 * @property {string} documentId
 * @property {string} topDocumentId
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
      // 文档身份：frameId 在同 frame 多次导航间保持不变，documentId 每次导航都换。
      // 只绑 frameId 无法识别"同 origin 但已换文档"，所以必须绑 documentId。
      documentId: fields.documentId,
      topDocumentId: fields.topDocumentId,
      origin: fields.origin,
      entryId: fields.entryId,
      username: fields.username || '',
      expiresAt: this.now() + this.ttlMs,
    });
    return this.records.get(nonce);
  }

  /**
   * **同步认领**：把 issued 独占推进到 validating。
   *
   * 这是并发安全的唯一入口。调用方必须在**任何 await 之前**调用它，
   * 拿到非 null 才算拥有兑换权。
   *
   * 任一项不符 → 删除记录并返回 null（**不留重试机会**）。
   *
   * @param {string} nonce
   * @param {{tabId:number, frameId:number, origin:string, entryId:string}} claimed
   *   调用方声明的绑定值。origin 必须是已规范化的字符串。
   * @returns {AuthRecord|null}
   */
  claim(nonce, claimed) {
    this.sweep();
    const r = this.records.get(nonce);
    if (!r) return null;
    if (r.state !== 'issued') {
      // 已被别的请求认领（validating）或已消费（consuming）。
      //
      // **这里绝不能删除记录**：并发场景下，第 2..N 个请求会在第一个请求
      // 还处于 validating 时到达。如果这里删了记录，第一个请求的 confirm()
      // 就会失败，结果是"100 个并发全部失败"——那才是真正的功能缺陷。
      //
      // 攻击者的重放也无法借此获得好处：记录已归第一个请求所有，
      // 后续请求拿不到任何东西。
      return null;
    }
    if (r.expiresAt <= this.now()) {
      this.records.delete(nonce);
      return null;
    }
    // 绑定值比对。documentId 由授权时记录，兑换时由 redeem.js 用 getFrame
    // 重新取得后比对；这里只比对调用方能提供的字段。
    if (
      r.tabId !== claimed.tabId ||
      r.frameId !== claimed.frameId ||
      r.origin !== claimed.origin ||
      r.entryId !== claimed.entryId
    ) {
      // 绑定值不符：这是明确的攻击信号（拿别人的 nonce 试），
      // 直接销毁，不给重试机会。
      this.records.delete(nonce);
      return null;
    }
    r.state = 'validating';
    return r;
  }

  /**
   * 浏览器侧校验通过：validating → consuming。
   *
   * 只接受仍处于 validating 的记录；否则返回 null（已被 abort 或超时）。
   */
  confirm(nonce) {
    const r = this.records.get(nonce);
    if (!r || r.state !== 'validating') return null;
    if (r.expiresAt <= this.now()) {
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

  /**
   * 兼容旧调用名的薄封装（内部等价于 claim + 立即 confirm）。
   * 仅供不涉及异步校验的场景使用；生产路径请用 claim/confirm 两段。
   */
  beginRedeem(nonce, claimed) {
    const r = this.claim(nonce, claimed);
    if (!r) return null;
    return this.confirm(nonce);
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

  /** 当前处于某状态的记录数（测试用）。 */
  countByState(state) {
    let n = 0;
    for (const r of this.records.values()) if (r.state === state) n += 1;
    return n;
  }
}
