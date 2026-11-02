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
 * 文章页：阅读模式的验收页面。
 *
 * 刻意做成"像真实文章页"的结构——导航 + 正文 + 侧栏 + 页脚。
 * 如果只给一段正文，测不出提取算法会不会被导航/侧栏误导。
 */
function pageArticle() {
  const paras = [
    '钥巢是一个本地优先的密码管理器。它不联网、不注册账号，所有数据加密后保存在本机。主密码通过 Argon2id 派生密钥，再以 XChaCha20-Poly1305 加密整个仓库。',
    '这个页面存在的目的是给阅读模式提供一份可提取的正文。它包含导航栏、侧栏推荐位和页脚，这些是真实文章页的常见结构，也是正文提取算法最容易误判的地方。',
    '阅读模式的实现刻意保守：提不出正文时什么都不做。这个取舍的理由是，把页面改坏比不做功能糟糕得多——用户会立刻卸载，而且不再尝试第二次。',
    '正文容器不会被移动，只被克隆。所以退出阅读模式时只需要移除克隆出来的容器和一条样式规则，原始文档结构完全没有被动过，必定可以还原。',
    '广告过滤与阅读模式共用同一套模块骨架：声明能力、声明配置、声明消息类型，其余交给宿主。加一个模块不需要改宿主代码。',
  ];
  return PAGE(
    'Site A Article',
    `<nav id="site-nav">
       <a href="/">首页</a> <a href="/other">归档</a> <a href="/about">关于</a>
       <a href="/rss">订阅</a> <a href="/login">登录</a>
     </nav>
     <div id="article-body">
       <h1>钥巢的设计取舍</h1>
       ${paras.map((t) => `<p>${t}</p>`).join('')}
     </div>
     <aside id="sidebar">
       <a href="/p1">推荐文章一</a> <a href="/p2">推荐文章二</a>
       <a href="/p3">推荐文章三</a> <a href="/p4">推荐文章四</a>
     </aside>
     <footer id="site-footer">版权所有</footer>`
  );
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
    if (p === '/article') {
      res.end(pageArticle());
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
