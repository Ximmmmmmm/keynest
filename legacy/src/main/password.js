'use strict';

/**
 * 密码生成与强度评估。
 * 使用 crypto.randomInt（无模偏差）取样，保证每个被勾选的字符集至少出现一次。
 */

const crypto = require('node:crypto');

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/~',
};

const AMBIGUOUS = '0O1lI|`\'"';

function poolFor(options) {
  let pool = '';
  for (const key of ['lower', 'upper', 'digits', 'symbols']) {
    if (options[key]) pool += SETS[key];
  }
  if (options.excludeAmbiguous) {
    pool = [...pool].filter((ch) => !AMBIGUOUS.includes(ch)).join('');
  }
  return pool;
}

function clamp(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function generatePassword(input) {
  const opts = {
    length: clamp(input && input.length, 6, 128) || 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: true,
    ...(input || {}),
  };
  if (!opts.lower && !opts.upper && !opts.digits && !opts.symbols) {
    opts.lower = true;
  }

  const pool = poolFor(opts);
  if (!pool) throw new Error('字符集为空');

  const groups = [];
  for (const key of ['lower', 'upper', 'digits', 'symbols']) {
    if (!opts[key]) continue;
    const set = opts.excludeAmbiguous
      ? [...SETS[key]].filter((ch) => !AMBIGUOUS.includes(ch)).join('')
      : SETS[key];
    if (set) groups.push(set);
  }

  const pick = (chars) => chars[crypto.randomInt(0, chars.length)];
  const chars = [];
  // 先为每个字符集放置一个字符，避免“勾了符号却一个都没有”
  for (const group of groups.slice(0, opts.length)) chars.push(pick(group));
  while (chars.length < opts.length) chars.push(pick(pool));

  // Fisher–Yates 洗牌
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function estimateStrength(password) {
  const pw = String(password || '');
  if (!pw) return { score: 0, bits: 0, label: '空', hint: '' };

  let poolSize = 0;
  if (/[a-z]/.test(pw)) poolSize += 26;
  if (/[A-Z]/.test(pw)) poolSize += 26;
  if (/[0-9]/.test(pw)) poolSize += 10;
  if (/[^A-Za-z0-9]/.test(pw)) poolSize += 28;

  // 实际字符种类越少，有效搜索空间越小（'aaaaaaaa' 不等于 8 位随机小写字母）
  const unique = new Set(pw).size;
  const effectivePool = Math.min(poolSize, Math.max(unique * 4, 2));
  const bits = Math.round(pw.length * Math.log2(effectivePool));

  // 常见弱模式惩罚
  const repeats = /(.)\1{2,}/.test(pw);
  const sequences = /(012|123|234|345|456|567|678|789|abc|qwe|asd|password|admin)/i.test(pw);
  const penalized = repeats || sequences ? Math.round(bits * 0.7) : bits;

  let score;
  let label;
  if (penalized < 40) {
    score = 1;
    label = '弱';
  } else if (penalized < 60) {
    score = 2;
    label = '一般';
  } else if (penalized < 80) {
    score = 3;
    label = '强';
  } else {
    score = 4;
    label = '很强';
  }

  const hints = [];
  if (pw.length < 12) hints.push('长度不足 12 位');
  if (repeats) hints.push('存在连续重复字符');
  if (sequences) hints.push('包含常见序列或弱口令片段');
  if (!/[^A-Za-z0-9]/.test(pw)) hints.push('缺少符号');

  return {
    score,
    bits: penalized,
    label,
    hint: hints.slice(0, 2).join('、'),
  };
}

module.exports = { generatePassword, estimateStrength, SETS, AMBIGUOUS };
