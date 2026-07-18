// SibyX Web Service —— Render Web Service 入口
// 设计原则（见《SibyX架构与E2EE边界》红线手册）：
//   本服务只做「静态托管 + 健康检查 + 预留安全后端路由」。
//   绝不碰明文 / 私钥；可后端化的只有 D–G 层（元数据/中继/公钥目录/密文同步），
//   且后端只存/转发密文与 {by,ts} 类元数据，保持纯 E2EE 不变。

const express = require('express');
const path = require('path');
const app = express();

// Render 注入的端口；本地回退 3000
const PORT = process.env.PORT || 3000;

// 托管前端静态文件（等价原 Static Site；把 index.html/app.js/styles.css/gun.js 放进本目录即生效）
app.use(express.static(path.join(__dirname, '.')));

// 健康检查 —— Render 据此判断实例存活（建议填到 Render 的 Health Check Path: /healthz）
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 兜底：根路径无静态首页时，返回状态文本（避免误以为部署失败）
app.get('/', (req, res) => {
  res.type('text/plain').send('SibyX Web Service is running. Frontend not deployed yet.');
});

// ===================== 预留：保持纯 E2EE 的后端安全路由 =====================
// 以下路由将来按红线手册实施，全部「不碰明文/私钥」：
//   app.use('/api/pubkey', require('./routes/pubkey'));  // 公钥目录服务 ✅（公钥本就公开）
//   app.use('/api/sync',   require('./routes/sync'));    // 密文多设备同步 ✅（只存密文 blob）
//   app.use('/api/notify', require('./routes/notify'));  // 推送唤醒 ✅（仅发"有消息"信号，无内容）
// 任何需要解密消息 / 读取私钥的路由都【禁止】，会破 E2EE。
// ===============================================================================

app.listen(PORT, () => {
  console.log('SibyX Web Service listening on :' + PORT);
});
