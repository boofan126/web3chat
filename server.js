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
// 静态响应头：
//   no-store    —— 避免 Cloudflare 边缘缓存免费层「冷启动空响应」
//   no-transform —— 关键：我们的 app.js/styles.css 已 terser 压缩，禁止 Cloudflare Auto Minify/Brotli 再改造（其冷启动改造失败会返回 0 字节空体）
app.use(express.static(path.join(__dirname, '.'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-transform'),
}));

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

// ===================== 预留：保持纯 E2EE 的后端安全路由 =====================
// 以下路由将来按红线手册实施，全部「不碰明文/私钥」：
//   app.use('/api/pubkey', require('./routes/pubkey'));  // 公钥目录服务 ✅（公钥本就公开）
//   app.use('/api/sync',   require('./routes/sync'));    // 密文多设备同步 ✅（只存密文 blob）
//   app.use('/api/notify', require('./routes/notify'));  // 推送唤醒 ✅（仅发"有消息"信号，无内容）
// 任何需要解密消息 / 读取私钥的路由都【禁止】，会破 E2EE。
// =================================================================================

module.exports = server;
