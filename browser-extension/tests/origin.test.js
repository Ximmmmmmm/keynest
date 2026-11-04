// origin 规范化的单元测试（node --test）。
//
// 这些用例必须与 Rust 侧 `keynest-egui/src/bridge/origin.rs` 的测试一一对应；
// 任何一侧改了规则，另一侧必须同步改。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, isFillable } from '../lib/origin.js';

test('只保留 scheme/host/port', () => {
  assert.equal(normalize('https://example.com/login?x=1#f'), 'https://example.com');
});

test('host 与 scheme 转小写', () => {
  assert.equal(normalize('HTTPS://Example.COM/Path'), 'https://example.com');
});

test('默认端口归一', () => {
  assert.equal(normalize('https://example.com:443'), 'https://example.com');
  assert.equal(normalize('http://example.com:80'), 'http://example.com');
});

test('非默认端口保留', () => {
  assert.equal(normalize('https://example.com:8443'), 'https://example.com:8443');
});

test('协议不同即不同 origin', () => {
  assert.notEqual(normalize('http://example.com'), normalize('https://example.com'));
});

test('相似域名绝不匹配', () => {
  assert.notEqual(normalize('https://example.com.evil.test'), normalize('https://example.com'));
  assert.notEqual(normalize('https://notexample.com'), normalize('https://example.com'));
});

test('子域是不同 origin', () => {
  assert.notEqual(normalize('https://mail.example.com'), normalize('https://example.com'));
});

test('拒绝非 http(s) 协议', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'mailto:a@b.c']) {
    assert.equal(normalize(bad), null, bad);
  }
});

test('拒绝缺少主机', () => {
  assert.equal(normalize('https://'), null);
  assert.equal(normalize('https:///path'), null);
  assert.equal(normalize(''), null);
});

test('去掉 userinfo', () => {
  assert.equal(normalize('https://user:pass@example.com/'), 'https://example.com');
});

test('IPv6 字面量', () => {
  assert.equal(normalize('https://[::1]:8443/x'), 'https://[::1]:8443');
});

test('只有 https 允许填充', () => {
  assert.equal(isFillable('https://example.com'), true);
  assert.equal(isFillable('http://example.com'), false);
});
