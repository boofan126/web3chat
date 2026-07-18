// SibyX Web Service —— Render Web Service 入口（Path A：自托管 Gun 存储 peer）
// 设计原则（见《SibyX架构与E2EE边界》红线手册）：
//   本服务只做「静态托管 + 健康检查 + 自托管 Gun peer(中继) + 预留安全后端路由」。
//   Gun peer 只存/转发密文与 {by,ts} 类元数据，绝不碰明文/私钥，保持纯 E2EE 不变。
//
// 架构要点（关键修复）：
//   - 主 server 只跑 express，独占 request 事件 → 前端静态文件（app.js/styles.css/index.html）
//     完整无截断，不被 Gun 干扰。
//   - Gun peer 跑在独立的本地端口（GUN_PORT），自身只处理 /gun（WebSocket 升级 + 握手）。
//   - 主 server 通过 /gun 代理把前端的 ws 流量透传到本地 Gun peer。
//   这样 express 静态托管 与 Gun 协议端点 彻底分离，互不抢占 response。

const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const express = require('express');
const Gun = require('gun');

const app = express();

const PORT = process.env.PORT || 3000;
const GUN_PORT = process.env.GUN_PORT || 8765;

// 防源码泄露：静态托管根目录时，屏蔽服务侧敏感文件
const BLOCK = new Set(['/server.js', '/package.json', '/package-lock.json', '/.env']);
app.use((req, res, next) => {
  if (BLOCK.has(req.path)) return res.status(404).end();
  next();
});

// 托管前端静态文件（express 独占 request，不受 Gun 干扰，前端产物由 build 同步进来）
// 注意：不用 express.static 的流式响应 —— 其 chunked 流式会被 Cloudflare/Render 边缘在代理时截断，
//       导致 app.js/styles.css/index.html 偶发 0 字节空体（小缓冲响应如 /healthz 正常）。
//       改为「整文件读入内存 + 显式 Content-Length + Content-Encoding: identity」缓冲式发送，
//       彻底消除边缘对流式大文件的截断面。文件均 ≤200KB，内存开销可忽略。
const STATIC_DIR = path.join(__dirname, '.');
const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=UTF-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=UTF-8',
};
app.use((req, res, next) => {
  if (BLOCK.has(req.path)) return res.status(404).end();
  let p = decodeURIComponent(req.path.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(STATIC_DIR, p));
  if (!fp.startsWith(STATIC_DIR)) return next(); // 防目录穿越
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) return next();
    const ext = path.extname(fp).toLowerCase();
    // 用 res.sendFile（内部带 Content-Length 的流式，非纯 chunked）。
    // 注意：纯 chunked 流式会被 Cloudflare/Render 边缘在代理时截断（app.js 等偶发 0 字节），
    // sendFile 主动带 Content-Length 可规避该截断；no-transform 再禁止 Cloudflare 改造已压缩资源。
    res.set('Content-Type', MIME[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'no-store, no-transform');
    res.sendFile(fp, (e) => { if (e && !res.headersSent) next(); });
  });
});

// 健康检查 —— Render 据此判断实例存活（Health Check Path 建议填 /healthz）
app.get('/healthz', (req, res) => res.json({ ok: true, gun: true, ts: Date.now() }));

// 兜底：根路径无静态首页时返回状态文本（避免误以为部署失败）
app.get('/', (req, res, next) => {
  if (req.path !== '/') return next();
  res.type('text/plain').send('SibyX Web Service running. Frontend deploying...');
});

// 主 server：仅 express（无 Gun 的 request 监听器，确保静态托管完整）
const server = app.listen(PORT, () => {
  console.log('SibyX Web Service listening on :' + PORT);
});

// ============ 自托管 Gun 存储 peer（Path A 核心，独立端口，不干扰前端静态）============
// 前端 RELAY_URL = https://<本服务 host>/gun 时，消息/元数据经下方代理同步到此处并持久化。
// 持久化目录 ./data（Radisk，只存密文+元数据，不含明文/私钥）。已加入 .gitignore。
const gunServer = http.createServer();
Gun({
  web: gunServer,
  file: path.join(__dirname, 'data'),
  radisk: true,
});
gunServer.listen(GUN_PORT, '127.0.0.1', () => {
  console.log('Gun peer listening on 127.0.0.1:' + GUN_PORT);
});

// ============ 将 /gun 代理到本地 Gun peer（HTTP 握手 + WebSocket 升级）============
// 普通 HTTP 请求（/gun 握手初始化等）
app.all(['/gun', '/gun/*'], (req, res) => {
  const opts = {
    host: '127.0.0.1',
    port: GUN_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };
  const p = http.request(opts, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  p.on('error', () => res.status(502).end());
  req.pipe(p);
});

// WebSocket 升级：把 /gun 的 ws 升级请求透传到本地 Gun peer
server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/gun')) {
    socket.destroy();
    return;
  }
  const client = net.connect(GUN_PORT, '127.0.0.1', () => {
    let raw = 'GET ' + req.url + ' HTTP/1.1\r\n';
    for (const k in req.headers) raw += k + ': ' + req.headers[k] + '\r\n';
    raw += '\r\n';
    client.write(raw);
    if (head && head.length) client.write(head);
  });
  client.pipe(socket);
  socket.pipe(client);
  client.on('error', () => socket.destroy());
  socket.on('error', () => client.destroy());
});

// ===================== ⑤ 自定义 API（与 Gun 并存，严格不破 E2EE 红线）=====================
// 实现见 api.js（公钥目录 / 加密备份库 / 唤醒信号），全部「只见公钥·密文·信号，不碰明文·私钥·频道密钥 K」。
// 挂载点仅 /api/* —— 该路由内部自解析 JSON，绝不影响上方 /gun 代理的原始 body 流。
app.use('/api', require('./api'));

// =================================================================================

module.exports = server;
