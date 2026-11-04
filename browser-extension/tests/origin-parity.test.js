// origin 三处实现的一致性测试。
//
// 三份代码：
//   A. lib/origin.js            —— SW / popup 使用
//   B. content/content-script.js 里内联的 normalizeOrigin（MV3 content script 不支持 ESM）
//   C. Rust keynest-egui/src/bridge/origin.rs（由 cargo test 覆盖，此处只做清单对照）
//
// 如果 A 和 B 的行为分叉，"SW 认为匹配、content script 认为不匹配"或反过来，
// 就会出现安全空洞。这里用同一批输入逐条比对。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../lib/origin.js';

/**
 * 从 content-script.js 里取出内联的 normalizeOrigin 并实例化。
 * 直接读源码而不是复制粘贴，保证测的是**实际会运行的那份代码**。
 */
function loadInlineNormalize() {
  const src = readFileSync(new URL('../content/content-script.js', import.meta.url), 'utf8');
  const start = src.indexOf('function normalizeOrigin(raw) {');
  if (start === -1) throw new Error('content-script.js 里找不到 normalizeOrigin');

  // 花括号配对，取出完整函数体
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (depth === 0) { end = k + 1; break; }
    }
  }
  if (end === -1) throw new Error('函数体不完整');
  const fnSrc = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}; return normalizeOrigin;`)();
}

const inlineNormalize = loadInlineNormalize();

const CASES = [
  'https://example.com',
  'https://example.com/',
  'https://example.com/login?x=1#f',
  'HTTPS://Example.COM/Path',
  'https://example.com:443',
  'https://example.com:8443',
  'http://example.com',
  'http://example.com:80',
  'https://example.com.evil.test',
  'https://evil-example.com',
  'https://sub.example.com',
  'https://user:pass@example.com/',
  'https://[::1]:8443/x',
  'https://',
  'https:///path',
  '',
  '   ',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'chrome://settings',
  'mailto:a@b.c',
  'data:text/html,x',
];

test('PASS: lib/origin.js 与 content script 内联实现逐条一致', () => {
  for (const input of CASES) {
    const a = normalize(input);
    const b = inlineNormalize(input);
    assert.equal(a, b, `不一致：${JSON.stringify(input)} → lib=${a} inline=${b}`);
  }
});

test('PASS: 子域不被当作主域', () => {
  assert.notEqual(normalize('https://sub.example.com'), normalize('https://example.com'));
});

test('PASS: 相似域名不被当作同一 origin', () => {
  assert.notEqual(
    normalize('https://example.com.evil.test'),
    normalize('https://example.com')
  );
  assert.notEqual(normalize('https://evil-example.com'), normalize('https://example.com'));
});

test('PASS: 协议不同即不同 origin', () => {
  assert.notEqual(normalize('http://example.com'), normalize('https://example.com'));
});

test('PASS: 端口不同即不同 origin', () => {
  assert.notEqual(normalize('https://example.com:8443'), normalize('https://example.com'));
});

test('PASS: 默认端口被归一', () => {
  assert.equal(normalize('https://example.com:443'), normalize('https://example.com'));
  assert.equal(normalize('http://example.com:80'), normalize('http://example.com'));
});

test('PASS: 带凭据的 URL 去掉 userinfo 后仍可比较', () => {
  assert.equal(normalize('https://user:pass@example.com/'), 'https://example.com');
});

test('PASS: 非法与非 HTTP(S) 协议返回 null', () => {
  for (const bad of ['https://', 'https:///path', '', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'mailto:a@b.c']) {
    assert.equal(normalize(bad), null, bad);
    assert.equal(inlineNormalize(bad), null, bad);
  }
});

test('PASS: 大小写规范化一致', () => {
  assert.equal(normalize('HTTPS://EXAMPLE.COM/'), 'https://example.com');
  assert.equal(inlineNormalize('HTTPS://EXAMPLE.COM/'), 'https://example.com');
});
