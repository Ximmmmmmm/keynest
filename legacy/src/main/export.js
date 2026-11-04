'use strict';

/**
 * 明文导出与格式转换。
 *
 * 为什么必须有：密码管理器只允许进不允许出，等于把用户数据锁死。
 * 开源项目尤其需要这一点 —— 任何人选择离开时，数据必须能完整带走。
 *
 * 支持：
 *   - CSV（Chrome / Edge / Firefox / Bitwarden / 1Password 通用，可回灌浏览器）
 *   - JSON（本项目的完整结构，含备注、分类、时间戳，用于迁移或备份）
 *
 * 注意：导出结果是**明文**，调用方有责任提示用户妥善保管并及时删除。
 */

const CSV_COLUMNS = ['name', 'url', 'username', 'password', 'note'];

/** CSV 字段转义：含逗号、引号、换行时加引号，内部引号翻倍 */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * 导出为 CSV。
 * 列顺序与 Chrome / Edge / Firefox 的导出格式一致，可直接被它们重新导入。
 * @param {Array} entries
 * @returns {string}
 */
function toCsv(entries) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const entry of entries || []) {
    lines.push(
      [
        csvCell(entry.title),
        csvCell(entry.url),
        csvCell(entry.username),
        csvCell(entry.password),
        csvCell(entry.notes),
      ].join(','),
    );
  }
  // 结尾换行，符合常见 CSV 约定
  return lines.join('\r\n') + '\r\n';
}

/**
 * 导出为 JSON。保留完整字段，便于无损迁移。
 */
function toJson(entries, meta = {}) {
  return JSON.stringify(
    {
      format: 'keynest.export.v1',
      exportedAt: new Date().toISOString(),
      count: (entries || []).length,
      ...meta,
      entries: (entries || []).map((e) => ({
        title: e.title,
        username: e.username,
        password: e.password,
        url: e.url,
        category: e.category,
        notes: e.notes,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    },
    null,
    2,
  );
}

/**
 * 生成导出文件名，例如 keynest-20261031-1620.csv
 */
function suggestFileName(ext, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `keynest-${stamp}.${ext}`;
}

module.exports = {
  CSV_COLUMNS,
  csvCell,
  toCsv,
  toJson,
  suggestFileName,
};
