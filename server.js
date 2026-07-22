// SPDX-License-Identifier: AGPL-3.0
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Gun = require('gun');

const app = express();
const PORT = process.env.PORT || 3000;
const GUN_PORT = process.env.GUN_PORT || 8765;

// 安全响应头：保留 HSTS / X-Frame-Options / X-Content-Type-Options 等，
// 但【关闭 CSP】—— 我们 Gun 中继是跨域(relay.chatweb3.online / web3chat-e6or.onrender.com / chat4hub-relay.onrender.com)，
// 若开默认 CSP(connect-src 'self')会 BLOCK 中继连接导致 APP 无法同步。定制 CSP 留待 v3(Playwright 实测能连中继后)。
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// 限流：/api 1000 次/15min/IP，防刷/防滥用，不影响正常用户
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, msg: 'rate limit exceeded' }
});
app.use('/api', apiLimiter);

// 禁止直接访问敏感文件
const BLOCK = new Set(['/server.js', '/package.json', '/package-lock.json', '/.env']);
app.use((e, t, r) => { if (BLOCK.has(e.path)) return t.status(404).end(); r(); });

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
  '.txt': 'text/plain; charset=UTF-8'
};

// 静态托管 + 按类型 Cache-Control（Step2b：index.html/sw.js→no-cache；js/css/图标→immutable；其余→no-store）
app.use((e, t, r) => {
  let n = decodeURIComponent(e.path.split('?')[0]);
  if (n === '/') n = '/index.html';
  const s = path.normalize(path.join(STATIC_DIR, n));
  if (!s.startsWith(STATIC_DIR)) return r();
  fs.stat(s, (e2, f) => {
    if (e2 || !f.isFile()) return r();
    const a = path.extname(s).toLowerCase();
    const b = path.basename(s).toLowerCase();
    let cc = 'no-store';
    if (b === 'index.html' || b === 'sw.js') cc = 'no-cache';
    else if (['.js', '.css', '.svg', '.png', '.ico', '.webmanifest', '.json', '.txt', '.woff', '.woff2', '.ttf'].includes(a)) cc = 'public, max-age=31536000, immutable';
    t.set('Content-Type', MIME[a] || 'application/octet-stream');
    t.set('Cache-Control', cc);
    t.sendFile(s, e3 => { e3 && !t.headersSent && r(); });
  });
});

app.get('/healthz', (e, t) => t.json({ ok: true, gun: true, ts: Date.now() }));

app.get('/', (e, t, r) => {
  if (e.path !== '/') return r();
  t.type('text/plain').send('SibyX Web Service running. Frontend deploying...');
});

const server = app.listen(PORT, () => { console.log('SibyX Web Service listening on :' + PORT); });

const gunServer = http.createServer();
const gun = Gun({
  web: gunServer,
  file: path.join(__dirname, 'data'),
  radisk: true,
  peers: ['https://chat4hub-relay.onrender.com/gun', 'https://relay.chatweb3.online/gun?peerkey=pR3lAyM3sh_7Qx9vK2nB8wL4d']
});

gunServer.listen(GUN_PORT, '127.0.0.1', () => { console.log('Gun peer listening on 127.0.0.1:' + GUN_PORT); });

// /gun 代理：http 请求 + websocket 升级，转发到本地 127.0.0.1:GUN_PORT
app.all(['/gun', '/gun/*'], (e, t) => {
  const r = { host: '127.0.0.1', port: GUN_PORT, path: e.url, method: e.method, headers: e.headers };
  const n = http.request(r, ee => { t.writeHead(ee.statusCode, ee.headers); ee.pipe(t); });
  n.on('error', () => t.status(502).end());
  e.pipe(n);
});

server.on('upgrade', (e, t, r) => {
  if (!e.url || !e.url.startsWith('/gun')) return void t.destroy();
  const n = net.connect(GUN_PORT, '127.0.0.1', () => {
    let t2 = 'GET ' + e.url + ' HTTP/1.1\r\n';
    for (const r2 in e.headers) t2 += r2 + ': ' + e.headers[r2] + '\r\n';
    t2 += '\r\n';
    n.write(t2);
    r && r.length && n.write(r);
  });
  n.pipe(t);
  t.pipe(n);
  n.on('error', () => t.destroy());
  t.on('error', () => n.destroy());
});

app.use('/api', require('./api'));

// 集中错误处理：未捕获异常转优雅 500，避免裸崩
app.use((err, req, res, next) => {
  console.error('[' + new Date().toISOString() + '] Error:', err && err.message);
  res.status((err && err.status) || 500).json({ ok: false, msg: (err && err.message) || 'internal server error' });
});

module.exports = server;
