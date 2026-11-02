// origin 规范化——与 Rust 侧 `keynest-egui/src/bridge/origin.rs` 保持同一套规则。
//
// 这里**必须**和 Rust 实现逐条对齐：两边算法不一致，就会出现
// "扩展认为匹配、KeyNest 认为不匹配"或者更糟的反向情况。

/**
 * 规范化成 `scheme://host[:port]`，失败返回 null。
 * @param {string} raw
 * @returns {string|null}
 */
export function normalize(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const idx = text.indexOf('://');
  if (idx <= 0) return null;
  const scheme = text.slice(0, idx).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  let rest = text.slice(idx + 3);
  // 去掉路径 / 查询 / 片段
  const cut = rest.search(/[/?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);

  // 去掉 userinfo
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);
  if (!rest) return null;

  let host;
  let port = null;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) return null;
    host = rest.slice(0, close + 1);
    const after = rest.slice(close + 1);
    if (after.startsWith(':')) port = after.slice(1);
    else if (after !== '') return null;
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    } else {
      host = rest;
    }
  }

  if (!host) return null;
  if (port !== null) {
    if (!/^[0-9]+$/.test(port)) return null;
    const isDefault = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
    if (!isDefault) return `${scheme}://${host.toLowerCase()}:${port}`;
  }
  return `${scheme}://${host.toLowerCase()}`;
}

/** 当前策略：只有 https 允许填充。 */
export function isFillable(origin) {
  return typeof origin === 'string' && origin.startsWith('https://');
}
