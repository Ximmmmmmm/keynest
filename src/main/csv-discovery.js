'use strict';

/**
 * 自动发现「浏览器刚导出的 CSV」。
 *
 * 设计目标：用户只点一次「导入」，不再需要自己找文件路径。
 *
 * 做法：
 *   1. 盯住常见导出目录（下载 / 桌面 / 文档）
 *   2. 优先返回最近几分钟内新增或修改过的 CSV
 *   3. 没有新鲜文件时，返回最近修改的那一批（并告知它们有多旧）
 *
 * 重要：从 Chrome 和 Edge 各导出一次会得到两个文件，用户期望**两个都导入**。
 * 所以这里返回的是一个「待导入集合」，而不是单个文件。
 *
 * 不依赖任何浏览器内部机制，也不需要绕过 v20 —— 浏览器导出的 CSV 是官方通道，
 * 这里只负责把「导出之后」的定位动作自动化。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_CSV_BYTES = 20 * 1024 * 1024;

/** 新鲜窗口：5 分钟内修改过的 CSV 视为「刚导出的」 */
const FRESH_WINDOW_MS = 5 * 60 * 1000;

/** 一次最多合并多少个文件，防止下载目录里堆满 CSV 时误导入 */
const MAX_FILES = 10;

function defaultDirs() {
  const home = os.homedir();
  const dirs = [];
  const push = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  push(path.join(home, 'Downloads'));
  push(path.join(home, 'Desktop'));
  push(path.join(home, 'Documents'));
  return dirs;
}

/**
 * 在目录里找候选 CSV。
 * @returns {{fresh: Array, stale: Array, scannedDirs: string[]}}
 */
function collect(dirList) {
  const fresh = [];
  const stale = [];
  const scannedDirs = [];
  const now = Date.now();

  for (const dir of dirList) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    scannedDirs.push(dir);

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.csv$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);

      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_CSV_BYTES) continue;

      const item = {
        path: full,
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ageMs: now - stat.mtimeMs,
      };
      if (item.ageMs <= FRESH_WINDOW_MS) fresh.push(item);
      else stale.push(item);
    }
  }

  const byNewest = (a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  };
  fresh.sort(byNewest);
  stale.sort(byNewest);

  return { fresh, stale, scannedDirs };
}

/**
 * 挑出「用户大概率想导入」的 CSV 集合。
 *
 * 规则：
 *   - 有新鲜文件 → 全部新鲜文件都要（来自不同浏览器的导出应当合并）
 *   - 没有 → 取最近的那一批陈旧文件，标记 not confident（界面让用户确认）
 *   - 完全没有 → null
 *
 * @returns {{
 *   found: boolean, confident: boolean,
 *   files: Array, candidates: Array, scannedDirs: string[], truncated: boolean
 * }}
 */
function discover(dirList = defaultDirs()) {
  const { fresh, stale, scannedDirs } = collect(dirList);

  const pick = (list, confident) => {
    const truncated = list.length > MAX_FILES;
    const files = list.slice(0, MAX_FILES);
    return {
      found: files.length > 0,
      confident,
      files,
      // 单选兼容：保留第一个作为「主文件」，老调用方不用改
      file: files[0] || null,
      candidates: files,
      scannedDirs,
      truncated,
    };
  };

  if (fresh.length) return pick(fresh, true);
  if (stale.length) return pick(stale, false);
  return { found: false, confident: false, files: [], file: null, candidates: [], scannedDirs, truncated: false };
}

/** 把年龄说成人话，用于界面提示 */
function describeAge(ageMs) {
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

module.exports = {
  FRESH_WINDOW_MS,
  MAX_CSV_BYTES,
  MAX_FILES,
  defaultDirs,
  collect,
  discover,
  describeAge,
};
