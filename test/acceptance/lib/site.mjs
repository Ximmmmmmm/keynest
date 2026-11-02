// 验收用 HTTPS 站点：两个 origin、几个固定页面。
//
// 为什么自己起服务：真实 origin 语义要求真实协议 + 真实 host + 真实端口。
// 127.0.0.1:9445 与 localhost:9446 在 origin 上是两个不同的 host:port，
// 这样才测得出「跨站 iframe 不填充」和「跨 origin 查询不返回他站条目」。

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const PAGE = (title, body) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
${body}
</body></html>`;

const LOGIN_FORM = `
<form id="login">
  <input id="u" type="text" autocomplete="username" placeholder="username">
  <input id="p" type="password" autocomplete="current-password" placeholder="password">
  <button type="submit">登录</button>
</form>`;

/** 站点 A：顶层登录框 + 同源 iframe + 跨站 iframe（指向 B）。 */
function pageA() {
  return PAGE(
    'Site A',
    `${LOGIN_FORM}
     <iframe id="same" src="/iframe-same" width="400" height="200"></iframe>
     <iframe id="cross" src="https://localhost:9446/" width="400" height="200"></iframe>
     <p id="marker">site-a</p>`
  );
}

function pageB() {
  return PAGE('Site B', `${LOGIN_FORM}<p id="marker">site-b</p>`);
}

function pageOther() {
  return PAGE('Site A Other', `${LOGIN_FORM}<p id="marker">site-a-other</p>`);
}

/**
 * 启动两个 HTTPS 实例。
 * @param {{certDir:string, portA:number, portB:number}} opts
 * @returns {Promise<{close:()=>Promise<void>}>}
 */
export async function startSites({ certDir, portA, portB }) {
  const key = fs.readFileSync(path.join(certDir, 'key.pem'));
  const cert = fs.readFileSync(path.join(certDir, 'cert.pem'));

  const handler = (host) => (req, res) => {
    const url = new URL(req.url, `https://${host}`);
    const p = url.pathname;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (host === 'site-b') {
      res.end(pageB());
      return;
    }
    if (p === '/other') {
      res.end(pageOther());
      return;
    }
    if (p === '/iframe-same') {
      res.end(PAGE('Same-origin iframe', LOGIN_FORM));
      return;
    }
    if (p === '/spa') {
      res.end(pageA());
      return;
    }
    res.end(pageA());
  };

  const a = https.createServer({ key, cert }, handler('site-a'));
  const b = https.createServer({ key, cert }, handler('site-b'));

  await Promise.all([
    new Promise((r) => a.listen(portA, '127.0.0.1', r)),
    new Promise((r) => b.listen(portB, '127.0.0.1', r)),
  ]);
  // localhost 在 IPv6 优先的环境里会解析到 ::1，额外监听一次更稳
  await new Promise((r) => {
    const extra = https.createServer({ key, cert }, handler('site-b'));
    extra.on('error', () => r());
    extra.listen(portB, '::1', () => {
      r();
      extra.close();
    });
  });

  return {
    close: () =>
      Promise.all([
        new Promise((r) => a.close(r)),
        new Promise((r) => b.close(r)),
      ]),
  };
}
