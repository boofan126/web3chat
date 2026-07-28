// SPDX-License-Identifier: AGPL-3.0
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { fork } = require('child_process');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Gun = require('gun');

const app = express();
const PORT = process.env.PORT || 3000;
const GUN_PORT = process.env.GUN_PORT || 8765;

// === 中继拓扑权威来源（与 app.js / bot.js 三处一致）===
// 客户端经 GET /shards 动态获取；bot gun 经本配置派生 peers。
// 当前 groups 为空 = 全量冗余（现状3台）；未来加分片组只改此处，前端/机器人自动扩，无需改码发包。
const RELAY_TOPOLOGY = {
  // #366 真分片切换（2026-07-28）已【回滚 P0-1·2026-07-28】：真分片令奇数分片仅存 Vultr 单点 + 多设备 VIP conc=5 触发 Vultr 429 拒连，
  // 致跨设备消息不可见 / 机器人不回复。回滚 groups=[] 恢复全量冗余（客户端直连 web3chat+chat4hub，Vultr 经 web3chat 服务端 mesh 镜像兜底），零改业务码。
  // 真分片代码保留，待每组 ≥2 台中继冗余再启用（见 PRINCIPLES.md）。
  // global=全局根(meta/dir/announce/rt)承载：web3chat(持久) + chat4hub(免费冗余)；Vultr 经服务端 mesh 镜像。
  global: [   // 客户端视角（不带 peerkey，与 OFFICIAL_RELAYS 一致）
    'https://web3chat-e6or.onrender.com/gun',
    'https://chat4hub-relay.onrender.com/gun'
  ],
  botPeers: [  // 服务端主 gun 视角（带 peerkey；#366 派生时自动剔除其他分片组成员=Vultr）
    'https://chat4hub-relay.onrender.com/gun',
    'https://relay.chatweb3.online/gun?peerkey=pR3lAyM3sh_7Qx9vK2nB8wL4d'
  ],
  // P0-1 回滚（2026-07-28）：groups=[] = 全量冗余（客户端直连 web3chat+chat4hub 两官方中继互为冗余，Vultr 经 web3chat 服务端 mesh 镜像兜底）。
  // 真分片（每组单点）已禁用；待每组 ≥2 台中继冗余后再行启用（见 PRINCIPLES.md）。
  groups: []
};
const SELF_RELAY = 'https://web3chat-e6or.onrender.com/gun';
const SHARD_COUNT = 32;   // ⚠️ 必须与 app.js / bot.js 完全一致（13.5 Phase3：3→32）
const SHARD_COUNT_NEXT = 32;   // 13.5 Phase1：双写目标分片数（与 app.js SHARD_COUNT_NEXT / Phase2 迁移脚本一致）
// === #366 真分片派生（groups=[] 时全部短路=现状）===
// 组映射与 app.js _groupKeyFor 完全一致：gi = sh % groups.length。
const GROUPS_N = RELAY_TOPOLOGY.groups.length;
const _stripQ = u => String(u || '').split('?')[0];   // botPeers 带 ?peerkey，比对须去 query
// 本节点所属组下标（-1=未配置分组或不在任何组）
const SELF_GI = GROUPS_N ? RELAY_TOPOLOGY.groups.findIndex(g => (g || []).some(u => _stripQ(u) === SELF_RELAY)) : -1;
// 非本组的分片中继集合：主 gun 绝不 peer 它们（peer=全量双向 gossip，连上=分片白切）
const _foreignGroupRelays = new Set(
  GROUPS_N ? RELAY_TOPOLOGY.groups.filter((g, gi) => gi !== SELF_GI).flat().map(_stripQ) : []
);

// Render 反向代理：信任第一层代理的 X-Forwarded-For，
// 使 express-rate-limit 能正确识别真实客户端 IP
app.set('trust proxy', 1);

// 安全响应头：启用严格 CSP（P0-#3，方案C，2026-07-27）。
// 默认同源自洽；connect-src 放开 https:/wss: 以放行官方3中继 + 外部存储 + 用户自定义中继；
// style-src 因前端大量内联 style 属性需放行 'unsafe-inline'（收紧为后续 P2 项）；
// script-src 仅 'self'（内联脚本已外置 boot.js），彻底堵死脚本注入类 XSS。
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      workerSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));
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

// 中继拓扑下发（13.1）：客户端启动时拉取，动态派生官方白名单；groups 为空=现状全量冗余。
app.get('/shards', (e, t) => t.json({ ok: true, global: RELAY_TOPOLOGY.global, groups: RELAY_TOPOLOGY.groups }));

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

// ===== #358 (2026-07-27)：中继侧 radisk 忽略 web3chat-rt（ephemeral typing/presence）=====
// 背景：13.4 把 typing/presence 从持久 web3chat-meta 拆到 ephemeral web3chat-rt 根。
//   rt 自过期（typing 3s 清、presence 心跳续期）、客户端按 ts 过滤，本就不该落盘——
//   落盘只会徒增磁盘 IO 与重启后陈旧数据。本段令 rt 仅留内存、不写 radisk。
// 机制：store.js 落盘前检查 msg._.rad，为 true 则跳过 radisk 写（store.js: if((msg._||'').rad){ return }）。
//   经本地实测，Gun.on('create') 内注册的 root.on('put') 拦截器，运行顺序在 store.js 落盘之前，
//   故对 web3chat-rt* soul 设 msg._.rad=true 即可生效（rt 不落盘，但仍在内存+正常 gossip 转发）。
// ⚠️ 前缀必须严格：仅 ^web3chat-rt($|/)，绝不可误伤 web3chat-meta / web3chat-chan-* 等真实持久根。
Gun.on('create', function (root) {
  this.to.next(root);
  root.on('put', function (msg) {
    var soul = msg.put && msg.put['#'];
    if (typeof soul === 'string' && soul.indexOf('web3chat-rt') === 0) {
      if (soul.length === 'web3chat-rt'.length || soul.charAt('web3chat-rt'.length) === '/') {
        msg._ = msg._ || {};
        msg._.rad = true;
      }
    }
    this.to.next(msg);
  });
});

// #366 真分片：主 gun 的 peers 必须剔除「其他分片组」的中继——Gun peer 是全量双向 gossip，
// 连上即互推全部 soul，分片立即白切。groups=[]（现状）时 _foreignGroupRelays 为空 → peers 不变。
const _mainPeers = RELAY_TOPOLOGY.botPeers.filter(u => !_foreignGroupRelays.has(_stripQ(u)));
const gun = Gun({
  web: gunServer,
  file: _gd.dir,
  radisk: true,
  peers: _mainPeers,   // 13.2 从拓扑派生；#366 分组后=非分片中继(chat4hub 等) + 本组成员（现状=chat4hub+vultr，行为不变）
});

// === 跨中继强制镜像（治数据孤岛）：主动订阅所有分片根，从 peers 拉全量+持续监听 ===
// Gun 纯 relay 仅靠转发，偶发丢+不拉历史+重启缺口；本段让本节点成为订阅者，
// 与 Vultr↔chat4hub 互做全量镜像，客户端连任意一台都能互通。
(function meshMirror(g) {
  const roots = [];
  // 13.5 Phase1：镜像订阅扩至 max(旧,新)=32 个分片根，双写落入的新根 3..31 同样获得跨中继回填冗余（web3chat=唯一持久源，必须订全）
  // #366 真分片：分组后只订「本组分片根」——订全会经共同 peer(如 chat4hub) 把其他组数据拉回本节点，分片白切。
  for (let sh = 0; sh < Math.max(SHARD_COUNT, SHARD_COUNT_NEXT); sh++) {
    if (GROUPS_N && SELF_GI !== -1 && (sh % GROUPS_N) !== SELF_GI) continue;   // groups=[] 时不跳过=现状
    roots.push('web3chat-chan-' + sh, 'web3chat-dm-' + sh);
  }
  roots.push('web3chat-meta', 'web3chat-announce');
  let n = 0;
  roots.forEach(r => { try { g.get(r).map().on(() => { n++; }); } catch (e) {} });
  console.log('[mesh-mirror] subscribed ' + roots.length + ' roots for cross-relay sync' + (GROUPS_N ? ' (group ' + SELF_GI + '/' + GROUPS_N + ')' : ''));
})(gun);

gunServer.listen(GUN_PORT, '127.0.0.1', () => { console.log('Gun peer listening on 127.0.0.1:' + GUN_PORT); });

// #366 真分片：bot 组客户端实例——其他分片组的数据只在对方中继，bot 须以「纯 Gun 客户端」直连对方组
// 才能订阅/回复该组频道。
//
// 关键隔离：同进程创建多个 Gun 实例会共享模块级 state（store/options/mesh），导致组 gun 与主 gun 互串，
// 任意 soul 经组 gun 泄漏到对方分片中继（实测 T1 RECEIVED）。解决方案 = 子进程隔离：
// 每个组 gun 跑在独立 Node 子进程，主进程通过 IPC 用远程 Gun 代理与 bot.js 对接。
const { createRemoteGunProxy } = require('./bot/remote-gun-proxy.js');
const _botGroupWorkers = new Map();   // gi -> ChildProcess
const _botGroupGuns = new Map();      // gi -> remote proxy
// P1-⑦ 组 gun 子进程：统一 spawn + 崩溃自动重拉（带退避），避免真分片启用时组实例静默死。
// 隔离红线：同进程多 Gun 实例共享模块级 state 互串成桥 → 每个组 gun 必须独立子进程（#366 教训）。
function spawnGroupWorker(gi) {
  const peerUrl = (RELAY_TOPOLOGY.groups[gi] || []).map(_stripQ)[0];
  if (!peerUrl) return;
  try {
    const worker = fork(path.join(__dirname, 'bot', 'bot-group-gun.js'), [peerUrl], {
      env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    worker.on('error', err => console.error('[bot] group worker ' + gi + ' error:', err && err.message));
    worker.on('exit', code => {
      console.error('[bot] group worker ' + gi + ' exited:', code);
      _botGroupWorkers.delete(gi); _botGroupGuns.delete(gi);
      setTimeout(() => spawnGroupWorker(gi), 2000);   // 2s 后自动重拉
    });
    _botGroupWorkers.set(gi, worker);
    _botGroupGuns.set(gi, createRemoteGunProxy(worker));
  } catch (e) { console.error('[bot] group worker ' + gi + ' create failed:', e && e.message); }
}
if (GROUPS_N && SELF_GI !== -1) {
  RELAY_TOPOLOGY.groups.forEach((grp, gi) => { if (gi !== SELF_GI) spawnGroupWorker(gi); });
  console.log('[bot] group client instances: ' + _botGroupGuns.size + ' (self group ' + SELF_GI + ')');
}
const _botGunFor = (sh) => {
  if (!GROUPS_N || SELF_GI === -1) return gun;
  const gi = sh % GROUPS_N;
  return gi === SELF_GI ? gun : (_botGroupGuns.get(gi) || gun);
};

// SibyX-AI 机器人：P1-⑦ supervisor——子进程隔离 + 崩溃自动重拉（exit 监听）。
// 替代原「同进程 require」：bot gun 独立，彻底规避与主 gun 模块级 state 互串（#366 红线）；
// 崩溃 / 未捕获异常 → bot-run 进程 exit(1) → supervisor 指数退避重拉（10min 内 >5 次停拉，防 crash-loop 烧资源）。
// ⚠️ 已知限制：真分片重新启用（groups≠[]）时，本独立 bot 进程需另行接入组 gun 路由（未来项，见 PRINCIPLES.md）。
const _botMainPeers = RELAY_TOPOLOGY.global.join(',');
let _botWorker = null, _botCrashes = 0, _botLastRestart = 0;
function startBotSupervisor() {
  if (_botWorker) return;
  try {
    const env = Object.assign({}, process.env, { SIBYX_BOT_PEERS: _botMainPeers });
    _botWorker = fork(path.join(__dirname, 'bot', 'bot-run.js'), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    _botWorker.on('error', err => console.error('[bot] supervisor worker error:', err && err.message));
    _botWorker.on('exit', (code, sig) => {
      console.error('[bot] supervisor worker exited: code=' + code + ' sig=' + sig);
      _botWorker = null;
      const now = Date.now();
      if (now - _botLastRestart > 600000) _botCrashes = 0;   // 10min 无崩溃 → 重置计数
      _botLastRestart = now; _botCrashes++;
      if (_botCrashes <= 5) {
        const delay = Math.min(30000, 2000 * _botCrashes);   // 2s,4s,6s…封顶30s 退避
        console.log('[bot] restarting bot in ' + delay + 'ms (crash #' + _botCrashes + ')');
        setTimeout(startBotSupervisor, delay);
      } else {
        console.error('[bot] too many crashes within 10min, stop auto-restart to avoid crash-loop burn');
      }
    });
  } catch (e) { console.error('[bot] supervisor fork failed:', e && e.message); }
}
startBotSupervisor();

// 主进程退出时清理组 gun 子进程
function cleanupGroupWorkers() {
  _botGroupWorkers.forEach((worker, gi) => {
    try { if (worker.connected) worker.disconnect(); } catch (e) {}
    try { worker.kill('SIGTERM'); } catch (e) {}
  });
}
process.on('exit', cleanupGroupWorkers);
process.on('SIGINT', () => { cleanupGroupWorkers(); process.exit(0); });
process.on('SIGTERM', () => { cleanupGroupWorkers(); process.exit(0); });

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
