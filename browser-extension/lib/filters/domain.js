// 域名匹配 —— 广告过滤里最容易写错、也最容易出安全问题的地方。
//
// # 为什么单独一个文件
//
// 一行的疏忽就能让「拦截 evil.com」变成「拦截 notevil.com」，
// 或者更糟：让「放行 bank.com」变成「放行 bank.com.evil.test」。
// 这类错误的共同点是**看起来对的**——测试只测正例时永远发现不了。
//
// 所以规则写在一处、测在一处，两侧都只依赖这个文件。
//
// # 三条硬规则
//
//   1. **后缀匹配必须在标签边界上**。`evil.com` 匹配 `a.evil.com`，
//      但**不**匹配 `notevil.com`、`evil.com.evil.test`。
//      实现方式：比较前补一个前导点，然后看是否以「.suffix」结尾。
//   2. **不做子串匹配**。`includes` 在这类场景里几乎总是错的。
//   3. **大小写不敏感**，且先规范掉首尾点与端口——否则 `evil.com.` 能绕过。
//
// # 这个文件不做什么
//
// 不解析 URL（那是调用方的事），不判断该不该拦（那是规则引擎的事）。
// 它只回答一个问题：**这个 host 属于这个域名吗。**

/**
 * 规范化域名：小写、去首尾点、去端口。
 *
 * 去端口是有意的：`evil.com:8080` 与 `evil.com` 在"是否属于这个域名"上是同一个答案。
 * 去尾部点是必需的：DNS 里 `evil.com.` 与 `evil.com` 等价，
 * 攻击者用带点的形式可以绕过朴素的字符串比较。
 *
 * @param {string} raw
 * @returns {string|null} 规范化后的域名；无法规范化返回 null
 */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;

  // 去端口（IPv6 字面量不在本函数的服务范围内，直接拒绝）
  if (s.startsWith('[')) return null;
  const colon = s.lastIndexOf(':');
  if (colon !== -1) s = s.slice(0, colon);

  // 去首尾点（DNS 绝对名、以及故意构造的 .evil.com. 形式）
  s = s.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!s) return null;

  // 基本形状：只允许字母数字、连字符、点；且每段非空
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  if (s.includes('..')) return null;
  for (const part of s.split('.')) {
    if (!part) return null;
    if (part.length > 63) return null;
  }
  if (s.length > 253) return null;
  return s;
}

/**
 * `host` 是否属于 `domain`（含该域名本身与其子域）。
 *
 * ```text
 * belongsTo('a.evil.com', 'evil.com')  → true
 * belongsTo('evil.com',   'evil.com')  → true
 * belongsTo('notevil.com','evil.com')  → false   ← 关键
 * belongsTo('evil.com.evil.test', 'evil.com') → false  ← 关键
 * ```
 *
 * @param {string} host
 * @param {string} domain
 */
export function belongsTo(host, domain) {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  if (h === d) return true;
  // 补前导点再比后缀：这就是"标签边界"的实现方式。
  // 直接 endsWith(d) 会让 notevil.com 命中 evil.com。
  return h.endsWith(`.${d}`);
}

/**
 * host 是否命中域名列表中的任意一项。
 * @param {string} host
 * @param {ReadonlyArray<string>} domains
 */
export function matchesAny(host, domains) {
  for (const d of domains) {
    if (belongsTo(host, d)) return true;
  }
  return false;
}

/**
 * 从 URL 里取 host。只接受 http/https。
 *
 * 用 `URL` 而不是正则：URL 解析的边界情况（userinfo、IPv6、百分号编码）
 * 多到不可能用正则覆盖全。浏览器自己解析的结果才是可信的那个。
 *
 * @param {string} url
 * @returns {string|null}
 */
export function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return normalizeDomain(u.hostname);
}
