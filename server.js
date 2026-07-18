// SibyX Web Service —— Render Web Service 入口（Path A：自托管 Gun 存储 peer）
// 设计原则（见《SibyX架构与E2EE边界》红线手册）：
//   本服务只做「静态托管 + 健康检查 + 自托管 Gun peer(中继) + 预留安全后端路由」。
//   Gun peer 只存/转发密文与 {by,ts} 类元数据，绝不碰明文/私钥，保持纯 E2EE 不变。
//   前端 RELAY_URL 指向 https://<host>/gun 即复用原有「写自己中继」模式，UI 零改动。

const path = require('path');
const express = require('express');
const Gun = require('gun');

const app = express();

// Render 注入的端口；本地回退 3000
const PORT = process.env.PORT || 3000;

// 防源码泄露：静态托管根目录时，屏蔽服务侧敏感文件
const BLOCK = new Set(['/server.js', '/package.json', '/package-lock.json', '/.env']);
app.use((req, res, next) => {
  if (BLOCK.has(req.path)) return res.status(404).end();
  next();
});

// 托管前端静态文件（等价原 Static Site；把 index.html/app.js/styles.css/gun.js 放进本目录即生效）
app.use(express.static(path.join(__dirname, '.')));

// 健康检查 —— Render 据此判断实例存活（Health Check Path 建议填 /healthz）
app.get('/healthz', (req, res) => res.json({ ok: true, gun: true, ts: Date.now() }));

// 兜底：根路径无静态首页时返回状态文本（避免误以为部署失败）
app.get('/', (req, res, next) => {
  if (req.path !== '/') return next();
  res.type('text/plain').send('SibyX Web Service running. Frontend deploying...');
});

const server = app.listen(PORT, () => {
  console.log('SibyX Web Service listening on :' + PORT);
});

// ============ 自托管 Gun 存储 peer（Path A 核心）============
// 前端 RELAY_URL = https://<本服务 host>/gun 时，消息/元数据即同步到此处并持久化。
// 持久化目录 ./data（Radisk，只存密文+元数据，不含明文/私钥）。已加入 .gitignore。
Gun({
  web: server,
  file: path.join(__dirname, 'data'),
  radisk: true,
});

// ===================== 预留：保持纯 E2EE 的后端安全路由 =====================
// 以下路由将来按红线手册实施，全部「不碰明文/私钥」：
//   app.use('/api/pubkey', require('./routes/pubkey'));  // 公钥目录服务 ✅（公钥本就公开）
//   app.use('/api/sync',   require('./routes/sync'));    // 密文多设备同步 ✅（只存密文 blob）
//   app.use('/api/notify', require('./routes/notify'));  // 推送唤醒 ✅（仅发"有消息"信号，无内容）
// 任何需要解密消息 / 读取私钥的路由都【禁止】，会破 E2EE。
// =================================================================================

module.exports = server;
