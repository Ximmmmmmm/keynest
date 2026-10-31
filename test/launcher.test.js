'use strict';

/**
 * 启动脚本检查：cmd.exe 对 LF 行尾 / 非 ASCII 字符 / 括号块的容忍度很差，
 * 一旦被编辑器改成 LF，双击就会静默失败。这里把它固定住。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'start.cmd');
const buf = fs.readFileSync(file);
const text = buf.toString('utf8');

const lf = (text.match(/\n/g) || []).length;
const crlf = (text.match(/\r\n/g) || []).length;
assert.strictEqual(lf, crlf, 'start.cmd 存在裸 LF 行尾，cmd.exe 会解析错乱');

const nonAscii = buf.filter((byte) => byte > 127).length;
assert.strictEqual(nonAscii, 0, 'start.cmd 含非 ASCII 字节，中文注释会因代码页错乱');

assert.ok(text.includes('"%ELECTRON_EXE%" .'), 'start.cmd 未把应用目录传给 Electron');

console.log('start.cmd 检查通过：CRLF、纯 ASCII、参数完整');
