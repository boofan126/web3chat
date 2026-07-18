// SibyX ⑤ 自定义 API（与 Gun 并存，严格不破 E2EE 红线）
// ── 红线：本文件只见【公钥 / 客户端加密后的密文 / 不透明唤醒信号】。
//    绝不碰：明文、私钥、频道对称密钥 K。所有校验只用公钥（地址派生 + ECDSA 验签）。
// ── 三个能力：
//    ① 公钥目录  /api/pubkey   （E2EE 安全：服务端只用公钥验证所有权）
//    ② 加密备份库 /api/backup  （服务端只见 AES-GCM+PBKDF2 密文，永远解不开）
//    ③ 唤醒信号   /api/wake    （只发"你有更新"信号，绝不带内容）
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const router = express.Router();
// ⚠️ 仅对 /api 路由解析 JSON；绝不能全局挂载，否则会吞掉 /gun 代理的原始 body 流。
router.use(express.json({ limit: '256kb' }));

const DATA = path.join(__dirname, 'apidata');
fs.mkdirSync(DATA, { recursive: true });
const PUBKEYS = path.join(DATA, 'pubkeys.json');
const BACKUPS = path.join(DATA, 'backups.json');
const WAKES = path.join(DATA, 'wakes.json');

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } }
function save(f, o) { fs.writeFileSync(f, JSON.stringify(o)); }

// ── 地址派生（与前端 app.js deriveAddress 完全一致）──
// 入参：65 字节未压缩公钥(base64) = [0x04, x(32), y(32)]
// 出参：'0x' + SHA256(raw).slice(-20).hex
function deriveAddress(signB64) {
  const raw = Buffer.from(signB64, 'base64');
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad_pub_len');
  const h = crypto.createHash('sha256').update(raw).digest();
  return '0x' + h.slice(-20).toString('hex');
}

// ── ECDSA-P256-SHA256 验签（原始 r‖s 64 字节，ieee-p1363）──
// 只用公钥，不碰私钥。挑战串由调用方约定。
async function verifySig(signB64, payloadStr, sigB64) {
  try {
    const raw = Buffer.from(signB64, 'base64');
    const x = raw.slice(1, 33).toString('base64url');
    const y = raw.slice(33, 65).toString('base64url');
    // ⚠️ createPublicKey 时即设 dsaEncoding；verify 直接传 KeyObject（勿再包 {key:pub,...}）
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk', dsaEncoding: 'ieee-p1363' });
    return crypto.verify('sha256', Buffer.from(payloadStr, 'utf8'), pub, Buffer.from(sigB64, 'base64'));
  } catch (e) { return false; }
}

const CHALLENGE = (addr, ts) => 'sibyx-pubkey-v1|' + addr + '|' + ts;

// ===================== ① 公钥目录 =====================
// POST /api/pubkey  { addr, sign, dh, nick, ts, sig }
//   服务端校验：① 地址须由签名公钥派生（防冒用他人地址）
//                ② sig 须是 challeng 的合法 ECDSA 签名（证明持有对应私钥，但私钥从不出服务端）
router.post('/pubkey', async (req, res) => {
  const { addr, sign, dh, nick, ts, sig } = req.body || {};
  if (!addr || !sign || !dh || !sig) return res.status(400).json({ ok: false, err: 'missing_fields' });
  let derived;
  try { derived = deriveAddress(sign); } catch (e) { return res.status(400).json({ ok: false, err: 'bad_sign_pub' }); }
  if (derived !== addr) return res.status(403).json({ ok: false, err: 'addr_mismatch' });
  const ok = await verifySig(sign, CHALLENGE(addr, ts), sig);
  if (!ok) return res.status(403).json({ ok: false, err: 'bad_sig' });
  const db = load(PUBKEYS);
  db[addr] = { addr, sign, dh, nick: (nick || '').slice(0, 40), ts: ts || Date.now() };
  save(PUBKEYS, db);
  res.json({ ok: true });
});

// GET /api/pubkey?addr=0x...  → 返回公钥（供他人发起 E2EE 时按地址查寻）
router.get('/pubkey', (req, res) => {
  const addr = req.query.addr;
  if (!addr) return res.status(400).json({ ok: false, err: 'missing_addr' });
  const r = load(PUBKEYS)[addr];
  if (!r) return res.status(404).json({ ok: false, err: 'not_found' });
  res.json({ ok: true, addr: r.addr, sign: r.sign, dh: r.dh, nick: r.nick, ts: r.ts });
});

// ===================== ② 加密备份库（服务端只见密文）=====================
// 前端 createEncryptedBackup(pass) → AES-GCM+PBKDF2 密文 JSON 字符串
// POST /api/backup  { id, ct }   → 服务端存 opaque 密文，永远看不到明文/私钥
router.post('/backup', (req, res) => {
  const { id, ct } = req.body || {};
  if (!id || !ct || typeof ct !== 'string' || ct.length > 200000) return res.status(400).json({ ok: false, err: 'bad' });
  const db = load(BACKUPS);
  db[String(id)] = { id: String(id), ct, ts: Date.now() };
  save(BACKUPS, db);
  res.json({ ok: true });
});

// GET /api/backup?id=...  → 取回密文（前端用 pass 解密，服务端解不开）
router.get('/backup', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ ok: false, err: 'missing_id' });
  const r = load(BACKUPS)[String(id)];
  if (!r) return res.status(404).json({ ok: false, err: 'not_found' });
  res.json({ ok: true, id: r.id, ct: r.ct, ts: r.ts });
});

// ===================== ③ 唤醒信号（P2-lite：只发信号，绝不带内容）=====================
// POST /api/wake  { addr, from }  → 给 addr 打一个不透明"待唤醒"标记
router.post('/wake', (req, res) => {
  const { addr, from } = req.body || {};
  if (!addr) return res.status(400).json({ ok: false, err: 'missing_addr' });
  const db = load(WAKES);
  db[addr] = { from: from || null, ts: Date.now() };
  save(WAKES, db);
  res.json({ ok: true });
});

// GET /api/wake?addr=...  → 查是否有待唤醒（有则客户端去 Gun 重新拉取；服务端无内容）
router.get('/wake', (req, res) => {
  const addr = req.query.addr;
  if (!addr) return res.status(400).json({ ok: false, err: 'missing_addr' });
  const db = load(WAKES);
  const r = db[addr];
  if (!r) return res.status(204).end();
  delete db[addr]; save(WAKES, db);
  res.json({ ok: true, from: r.from, ts: r.ts });
});

module.exports = router;
