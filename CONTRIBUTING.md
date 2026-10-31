# 贡献指南

感谢你愿意参与。这是个小型项目，规则尽量少，但有几条是硬的。

## 开发环境

```bash
git clone <repo>
cd keynest
npm install
npm start          # 启动应用
npm test           # 单元测试（不需要 Electron）
```

要求 Windows 10/11 + Node.js 18+（开发时用的是 Node 24）。

## 提交前必须跑

```bash
npm test           # 全部单元测试必须通过
```

改动涉及界面时，额外跑：

```bash
npm run test:ui
npm run test:e2e
```

CI 会跑 `npm test`，不通过的 PR 不会合并。

## 代码约定

- **纯 CommonJS + 原生 JS**，不引入构建步骤。这个项目刻意保持「改完就能跑」。
- **不新增运行时依赖**。加密只用 Node 内置 `crypto`。需要新依赖时请在 issue 里说明理由。
- 主进程代码放在 `src/main/`，必须能在无 Electron 环境下被 `require` 并单测（参考 `vault.js` / `browser-import.js`）。
- 所有用户内容进 DOM 前必须过 `esc()`。
- 新增 IPC 通道要同时改 `main.js`（handle）和 `preload.js`（白名单），不要在渲染进程里碰 `ipcRenderer`。

## 测试要求

- 新增纯逻辑（解析、加密、转换）→ 加单元测试，放在 `test/`，用现有的裸 `test()` 写法即可。
- 修复 bug → 补一个能复现该 bug 的测试。
- 涉及界面的改动 → 在 `test/ui-check.js` 里加断言。

## 不接受的内容

见 [SECURITY.md](SECURITY.md) 的「不在范围内的做法」。简单说：

- 不实现绕过浏览器凭据保护（v20 / App-Bound Encryption）的任何方案
- 不注入或替换浏览器进程
- 不引入把密码或密钥外传的代码，包括「可选的云同步」这类默认关闭的功能
- 不加遥测、崩溃上报、使用统计

## 提交信息

用中文或英文都行，一句话说清做了什么：

```
修复：导入超过 1000 条时界面卡顿
新增：条目支持 TOTP
文档：补充威胁模型说明
```

## 报告问题

- 功能建议 / 普通 bug → 开 issue
- 安全漏洞 → 走 [SECURITY.md](SECURITY.md) 里的私下渠道，不要开公开 issue

## 许可

提交的代码默认以 MIT 许可发布（见 [LICENSE](LICENSE)）。
