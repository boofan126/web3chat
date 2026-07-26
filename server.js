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

// Render 反向代理：信任第一层代理的 X-Forwarded-For，
// 使 express-rate-limit 能正确识别真实客户端 IP
app.set('trust proxy', 1);

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

app.get('/healthz', (e, t) => t.json({ ok: true, gun: true, datadir: _gd.dir, persistent: _gd.persistent, ts: Date.now() }));

// 一次性清档端点（测试重置用，部署后即刻调用并随后移除）：删除 radisk 数据目录后退出，
// Render 自动重启成空图。仅强随机令牌守卫，避免误触发；清完即空，mesh 镜像不会回填
// （三台协调清空时另两台也已空）。⚠️ 此端点为临时重置工具，清完即二次部署移除。
const WIPE_TOKEN = 'WIPE_7f3a9c2e8b140d5f6a2c9b3e7d1048a91ce';
app.get('/admin/wipe', (e, t) => {
  const tok = e.query.token || e.headers['x-admin-token'];
  if (tok !== WIPE_TOKEN && tok !== process.env.ADMIN_TOKEN) return t.status(403).json({ ok: false, msg: 'forbidden' });
  try { fs.rmSync(_gd.dir, { recursive: true, force: true }); console.log('[wipe] removed radisk dir', _gd.dir); }
  catch (err) { console.error('[wipe] rm err', err && err.message); }
  t.json({ ok: true, wiped: _gd.dir, restarting: true });
  setTimeout(() => process.exit(0), 300);
});

app.get('/', (e, t, r) => {
  if (e.path !== '/') return r();
  t.type('text/plain').send('SibyX Web Service running. Frontend deploying...');
});

const server = app.listen(PORT, () => { console.log('SibyX Web Service listening on :' + PORT); });

const gunServer = http.createServer();
// Gun 持久化目录解析（三级回退，零配置也能用持久盘）：
//  1) 显式 GUN_DATA_DIR 环境变量（最优先，精确控制挂载路径）
//  2) /data 目录存在且为目录（Render 后台挂持久盘后自动出现）→ 自动用持久盘
//  3) 都没有 → ./data（Render 临时盘，redeploy 即清，本中继不持久）
// 这样只要后台挂了盘，无需再设环境变量即自动生效；本中继成为“第2 持久兜底”，
// 与 Vultr 互为全量镜像（survive-one-down，任一宕机历史不丢）。
function resolveGunDataDir() {
  if (process.env.GUN_DATA_DIR) return { dir: process.env.GUN_DATA_DIR, tag: 'PERSISTENT DISK (GUN_DATA_DIR)', persistent: true };
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      // ⚠️ 必须用子目录 /data/gun 而非 /data 本身：
      // gun/lib/rfs.js:19 的临时文件路径是 opt.file + '-<key>-<rand>.tmp'（父目录拼接，非目录内），
      // 若 opt.file = '/data'，.tmp 会写到根目录 '/data-!-xxx.tmp' → 容器根目录只读 → EACCES →
      // 所有 put 失败 → 全设备消息断（2026-07-26 16:00 生产事故实锤）。
      // 用 /data/gun 后 .tmp 落在 '/data/gun-!-xxx.tmp'（持久盘内），必然可写。
      return { dir: '/data/gun', tag: 'PERSISTENT DISK (auto /data/gun)', persistent: true };
    }
  } catch (_) { /* ignore */ }
  return { dir: path.join(__dirname, 'data'), tag: 'ephemeral ./data', persistent: false };
}
const _gd = resolveGunDataDir();
// 一次性迁移：把历史根布局（radisk 文件直接散落在 /data 下）搬进 /data/gun，保住旧消息。
// radisk 文件名是 '!' 开头或 '%' 转义的图键文件；跳过我们自己的业务子目录（apidata 等）与普通文件。
try {
  if (_gd.dir === '/data/gun') {
    if (!fs.existsSync('/data/gun')) fs.mkdirSync('/data/gun', { recursive: true });
    const entries = fs.readdirSync('/data');
    for (const f of entries) {
      if (f === 'gun' || f === 'apidata') continue;                    // 目标目录与业务数据不动
      const src = '/data/' + f;
      try {
        if (!fs.statSync(src).isFile()) continue;                      // 只搬文件（radisk 全是文件）
        const dst = '/data/gun/' + f;
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);              // 已存在则保留新的，不覆盖
      } catch (_) { /* 单文件失败不阻断启动 */ }
    }
    console.log('[gun] legacy /data radisk files migrated into /data/gun');
  }
} catch (e) { console.error('[gun] migrate warn:', e && e.message); }
console.log('[gun] radisk data dir =', _gd.dir, '(' + _gd.tag + ')');
const gun = Gun({
  web: gunServer,
  file: _gd.dir,
  radisk: true,
  peers: ['https://chat4hub-relay.onrender.com/gun', 'https://relay.chatweb3.online/gun?peerkey=pR3lAyM3sh_7Qx9vK2nB8wL4d']
});

// === 跨中继强制镜像（治数据孤岛）：主动订阅所有分片根，从 peers 拉全量+持续监听 ===
// Gun 纯 relay 仅靠转发，偶发丢+不拉历史+重启缺口；本段让本节点成为订阅者，
// 与 Vultr↔chat4hub 互做全量镜像，客户端连任意一台都能互通。
(function meshMirror(g) {
  const roots = [];
  for (let sh = 0; sh < 3; sh++) { roots.push('web3chat-chan-' + sh, 'web3chat-dm-' + sh); }
  roots.push('web3chat-meta', 'web3chat-announce');
  let n = 0;
  roots.forEach(r => { try { g.get(r).map().on(() => { n++; }); } catch (e) {} });
  console.log('[mesh-mirror] subscribed ' + roots.length + ' roots for cross-relay sync');
})(gun);

gunServer.listen(GUN_PORT, '127.0.0.1', () => { console.log('Gun peer listening on 127.0.0.1:' + GUN_PORT); });

// SibyX-AI 机器人：同进程 / 同 Dyno 共部署，复用本 Gun peer（红线：私钥仅在本地签名，不出端）
try { require('./bot/bot.js').startBot(gun); }
catch (e) { console.error('[bot] require/start failed:', e && e.message); }

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
