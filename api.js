// SPDX-License-Identifier: AGPL-3.0
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const { z } = require('zod');
const router = express.Router();
router.use(express.json({ limit: '256kb' }));

const addrRe = /^0x[0-9a-fA-F]{40}$/;

// —— zod 形状校验（仅校验入参结构，绝不改动签名挑战串，保证与线上前端逐字节兼容）——
const pubkeyPostSchema = z.object({
  addr: z.string().regex(addrRe),
  sign: z.string(),
  dh: z.string(),
  nick: z.string().optional(),
  ts: z.coerce.string(),
  sig: z.string()
});
const addrQuerySchema = z.object({ addr: z.string().regex(addrRe) });
const backupPostSchema = z.object({
  id: z.string().regex(addrRe),
  ct: z.string().max(200000),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
const backupGetSchema = z.object({
  id: z.string().regex(addrRe),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
const wakePostSchema = z.object({
  addr: z.string().regex(addrRe),
  from: z.string().regex(addrRe),
  mid: z.string().optional(),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
const wakeGetSchema = z.object({
  addr: z.string().regex(addrRe),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
const wakeSubSchema = z.object({
  addr: z.string().regex(addrRe),
  // 前端发的是 PushSubscription 对象（非字符串），traework 的 z.string() 会误杀推送，故用 any
  subscription: z.any().optional(),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});

router.get('/policy', (e, t) => {
  t.set('Access-Control-Allow-Origin', '*');
  t.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  t.set('Access-Control-Allow-Headers', 'Content-Type');
  if ('OPTIONS' === e.method) return t.sendStatus(204);
  const P = {
    demo: { label: 'DEMO', maxInlineMB: 2, externalStorage: false, voice: false, attach: false, alwaysOn: false, concurrency: 1 },
    free: { label: 'FREE', maxInlineMB: 2, externalStorage: false, voice: false, attach: false, alwaysOn: false, concurrency: 2 },
    pro: { label: 'PRO', maxInlineMB: 4, externalStorage: true, voice: true, attach: true, alwaysOn: true, concurrency: 5 },
    vip: { label: 'VIP', maxInlineMB: 8, externalStorage: true, voice: true, attach: true, alwaysOn: true, concurrency: 1e9 }
  };
  t.json({ ok: true, policy: P, ts: Date.now() });
});

const DATA = path.join(__dirname, 'apidata');
fs.mkdirSync(DATA, { recursive: true });
const PUBKEYS = path.join(DATA, 'pubkeys.json');
const BACKUPS = path.join(DATA, 'backups.json');
const WAKES = path.join(DATA, 'wakes.json');
const WAKESUBS = path.join(DATA, 'wakesubs.json');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }
let VAPID = null;
try { VAPID = JSON.parse(fs.readFileSync(path.join(__dirname, 'vapid.json'), 'utf8')); }
catch (e) {
  try { if (webpush) { VAPID = webpush.generateVAPIDKeys(); fs.writeFileSync(path.join(__dirname, 'vapid.json'), JSON.stringify(VAPID)); } }
  catch (e2) { VAPID = null; }
}
if (VAPID && VAPID.publicKey && VAPID.privateKey) {
  try { webpush.setVapidDetails('mailto:sibyx@local', VAPID.publicKey, VAPID.privateKey); } catch (e) {}
}

function load(r) { try { return JSON.parse(fs.readFileSync(r, 'utf8')); } catch (r) { return {}; } }
// 原子写：先写临时文件，再 rename 到目标（同目录 rename 在 POSIX 上原子，读者要么看到旧文件要么看到完整新文件，绝不会看到半截 JSON）
function save(r, t) { const tmp = r + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(t)); fs.renameSync(tmp, r); }
// 并发锁：序列化对同一个 JSON 存储文件的 read-modify-write 临界区，杜绝 10 个并发请求交错写导致备份/公钥损坏或丢更新
const LOCK_OPTS = { retries: { minTimeout: 50, maxTimeout: 500, factor: 2 }, stale: 10000, realpath: false };
async function withLock(name, fn) {
  const lk = path.join(DATA, name + '.lock');
  const release = await lockfile.lock(lk, LOCK_OPTS);
  try { return await fn(); } finally { try { await release(); } catch (e) {} }
}
function deriveAddress(r) {
  const t = Buffer.from(r, 'base64');
  if (65 !== t.length || 4 !== t[0]) throw new Error('bad_pub_len');
  return '0x' + crypto.createHash('sha256').update(t).digest().slice(-20).toString('hex');
}
function verifySig(r, t, s) {
  try {
    const e = Buffer.from(r, 'base64');
    const o = e.slice(1, 33).toString('base64url');
    const n = e.slice(33, 65).toString('base64url');
    const i = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: o, y: n }, format: 'jwk' });
    // 浏览器 WebCrypto 与 Node crypto.sign 默认输出 IEEE-P1363（64 字节 r||s），
    // 必须显式指定 dsaEncoding，否则 Node verify 默认按 DER 解析导致验签失败。
    return crypto.verify('sha256', Buffer.from(t, 'utf8'), { key: i, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64'));
  } catch (r) { return false; }
}
// 统一签名校验：signB64=原始65B公钥(base64)、msgOrMsgs=待验明文(单串或候选串数组，用于双接受旧/新挑战串)、sigB64=签名、expectedAddr=期望地址、ts=客户端时间戳(ms)
// 防：缺字段 / 时间戳重放(>5min) / 公钥地址不匹配 / 签名无效。复用 deriveAddress+verifySig。
// 双接受：传入候选挑战串数组时，任一验签通过即放行（旧前端用旧串、升戳后新前端用新串，现网用户不受影响）。
function authSigned(signB64, msgOrMsgs, sigB64, expectedAddr, ts) {
  try {
    if (!signB64 || !msgOrMsgs || !sigB64 || !expectedAddr || !ts) return false;
    if (Math.abs(Date.now() - Number(ts)) > 300000) return false;
    if (deriveAddress(signB64) !== expectedAddr) return false;
    const arr = Array.isArray(msgOrMsgs) ? msgOrMsgs : [msgOrMsgs];
    for (const m of arr) {
      if (m && verifySig(signB64, m, sigB64)) return true;
    }
    return false;
  } catch (e) { return false; }
}
// 旧版 pubkey 挑战串常量已废弃（Plan B 第2步 2b：仅认新串 sibyx-pubkey-v1|addr|sign|dh|ts）

router.post('/pubkey', async (r, t) => {
  const p = pubkeyPostSchema.safeParse(r.body || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, sign: e, dh: o, nick: n, ts: i, sig: a } = p.data;
  let u;
  try { u = deriveAddress(e); } catch (r) { return t.status(400).json({ ok: false, err: 'bad_sign_pub' }); }
  if (u !== s) return t.status(403).json({ ok: false, err: 'addr_mismatch' });
  const newPubChal = 'sibyx-pubkey-v1|' + s + '|' + e + '|' + o + '|' + i;
  if (!verifySig(e, newPubChal, a)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  await withLock('pubkeys', async () => {
    const d = load(PUBKEYS);
    d[s] = { addr: s, sign: e, dh: o, nick: (n || '').slice(0, 40), ts: i || Date.now() };
    save(PUBKEYS, d);
  });
  t.json({ ok: true });
});

router.get('/pubkey', (r, t) => {
  const p = addrQuerySchema.safeParse(r.query || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const s = p.data.addr;
  const e = load(PUBKEYS)[s];
  if (!e) return t.status(404).json({ ok: false, err: 'not_found' });
  t.json({ ok: true, addr: e.addr, sign: e.sign, dh: e.dh, nick: e.nick, ts: e.ts });
});

router.post('/backup', async (r, t) => {
  const p = backupPostSchema.safeParse(r.body || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { id: s, ct: e, sign: sg, ts: i, sig: a } = p.data;
  if (!authSigned(sg, 'sibyx-backup-v1|' + s + '|' + i + '|' + e, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  await withLock('backups', async () => {
    const o = load(BACKUPS);
    o[String(s)] = { id: String(s), ct: e, ts: Date.now() };
    save(BACKUPS, o);
  });
  t.json({ ok: true });
});

router.get('/backup', (r, t) => {
  const p = backupGetSchema.safeParse(r.query || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { id: s, sign: sg, ts: i, sig: a } = p.data;
  if (!authSigned(sg, 'sibyx-backup-v1|' + s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  const e = load(BACKUPS)[String(s)];
  if (!e) return t.status(404).json({ ok: false, err: 'not_found' });
  t.json({ ok: true, id: e.id, ct: e.ct, ts: e.ts });
});

// ===== B-01 唤醒 + 真后台推送（a 轻量邮箱 + b VAPID）=====
// POST /wake：发 DM 时发送方携带 {addr:收件人, from:发件人, mid:消息id}（仅元数据，不破 E2EE）。
//   服务端：①存信号供 (a) 轮询取走；②若收件人已订阅则 web-push.sendNotification 触发 (b)。
router.post('/wake', async (r, t) => {
  const p = wakePostSchema.safeParse(r.body || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, from: e, mid: m, sign: sg, ts: i, sig: a } = p.data;
  if (!authSigned(sg, 'sibyx-wake-v1|' + s + '|' + e + '|' + String(m) + '|' + i, a, e, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  const o = { from: e || null, ts: Date.now(), mid: m || null };
  await withLock('wakes', async () => {
    const w = load(WAKES);
    w[s] = o;
    save(WAKES, w);
  });
  if (webpush && VAPID && WAKESUBS) {
    const subs = load(WAKESUBS);
    const sub = subs[s];
    if (sub) {
      try { webpush.sendNotification(sub, JSON.stringify({ from: e || null, mid: m || null, ts: o.ts, title: 'SibyX 新私聊' })).catch(() => {}); }
      catch (err) { /* 推送失败静默（订阅过期/撤销）*/ }
    }
  }
  t.json({ ok: true });
});

// GET /wake?addr=：收件人轮询取走信号（204=无，200=有），取走即删
router.get('/wake', async (r, t) => {
  const p = wakeGetSchema.safeParse(r.query || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, sign: sg, ts: i, sig: a } = p.data;
  if (!authSigned(sg, 'sibyx-wake-v1|' + s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  const e = load(WAKES);
  if (!e[s]) return t.status(204).end();
  const o = e[s];
  await withLock('wakes', async () => {
    const w = load(WAKES);
    delete w[s];
    save(WAKES, w);
  });
  t.json({ ok: true, from: o.from, ts: o.ts, mid: o.mid });
});

// POST /wake/sub：{addr, subscription} 存/删订阅（b 用）；subscription=null 即取消
router.post('/wake/sub', async (r, t) => {
  const p = wakeSubSchema.safeParse(r.body || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, subscription: sub, sign: sg, ts: i, sig: a } = p.data;
  if (!authSigned(sg, 'sibyx-wakesub-v1|' + s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  await withLock('wakesubs', async () => {
    const subs = load(WAKESUBS);
    if (sub) { subs[s] = sub; } else { delete subs[s]; }
    save(WAKESUBS, subs);
  });
  t.json({ ok: true });
});

// GET /vapid：返回 VAPID 公钥（客户端订阅推送时要用）
router.get('/vapid', (r, t) => {
  if (VAPID && VAPID.publicKey) return t.json({ ok: true, publicKey: VAPID.publicKey });
  t.json({ ok: false });
});

// ===== 邀请得 Pro（仅频道邀请 / 3 人有效 = 30 天 Pro）=====
const REFERRALS = path.join(DATA, 'referrals.json');
const GRANTS = path.join(DATA, 'grants.json');
const SIBYX_SECRET = process.env.SIBYX_SECRET || '';   // 与中继同密钥（用户在 Render 后台设）
const REFERRAL_NEED = 3;
const MSG_NEED = 4;        // 每位被邀者需发消息 > 3 条（即 ≥4）才算「有效邀请」
const PRO_DAYS = 30;
// 中继同款令牌签发（SIBYX1.<h>.<p>.<sig>，HMAC-SHA256(h+'.'+p, SIBYX_SECRET)）
// relay.js 的 verifyToken 不校验 h 内容，仅将其并入 HMAC 输入，故 h 取固定标识串即可。
function issueProToken(addr) {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = nowSec + PRO_DAYS * 86400;
  const payload = { tier: 'pro', id: addr, iat: nowSec, exp: exp, quota: 'referral', dev: 'sibyx' };
  const h = Buffer.from('sibyx-lic', 'utf8').toString('base64url');
  const pp = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const ss = crypto.createHmac('sha256', Buffer.from(SIBYX_SECRET, 'utf8')).update(h + '.' + pp).digest('base64url');
  return 'SIBYX1.' + h + '.' + pp + '.' + ss;
}
const referralPostSchema = z.object({
  inviter: z.string().regex(addrRe),
  invitee: z.string().regex(addrRe),
  channel: z.string().min(1).max(120),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
const referralStatusSchema = z.object({
  addr: z.string().regex(addrRe),
  sign: z.string(),
  ts: z.coerce.string(),
  sig: z.string()
});
// POST /referral：被邀者发首条消息时上报（用自己私钥签，证明确系其本人+同意）
router.post('/referral', async (r, t) => {
  const pj = referralPostSchema.safeParse(r.body || {});
  if (!pj.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { inviter: inv, invitee: invE, channel: ch, sign: sg, ts: i, sig: a } = pj.data;
  if (inv === invE) return t.status(400).json({ ok: false, err: 'self_invite' });
  const chal = 'sibyx-referral-v1|' + inv + '|' + invE + '|' + ch + '|' + i;
  if (!authSigned(sg, chal, a, invE, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  let granted = false, msgs = 0;
  await withLock('referrals', async () => {
    const d = load(REFERRALS);
    const rec = d[invE];
    if (!rec) {
      d[invE] = { inviter: inv, channel: ch, msgs: 1, ts: Date.now() };   // 首次上报，绑定邀请人
      msgs = 1;
    } else {
      if (rec.inviter !== inv) { msgs = rec.msgs || 0; return; }           // 首次绑定的邀请人为准，忽略他人冒领
      if ((rec.msgs || 0) < MSG_NEED) rec.msgs = (rec.msgs || 0) + 1;      // 累计消息条数（封顶 MSG_NEED，省空间）
      rec.lastTs = Date.now();
      msgs = rec.msgs || 0;
    }
    save(REFERRALS, d);
    // 有效邀请 = 该邀请人名下、消息条数达标(≥MSG_NEED)的被邀者数
    const cnt = Object.values(d).filter(x => x.inviter === inv && (x.msgs || 0) >= MSG_NEED).length;
    const g = load(GRANTS);
    if (cnt >= REFERRAL_NEED && !g[inv]) {
      g[inv] = { token: issueProToken(inv), tier: 'pro', exp: Math.floor(Date.now() / 1000) + PRO_DAYS * 86400, grantedAt: Date.now() };
      save(GRANTS, g);
      granted = true;
    }
  });
  t.json({ ok: true, msgs, granted, need: REFERRAL_NEED, msgNeed: MSG_NEED });
});
// GET /referral/status?addr=&sign=&ts=&sig=：邀请人轮询领取 Pro 令牌
router.get('/referral/status', (r, t) => {
  const pj = referralStatusSchema.safeParse(r.query || {});
  if (!pj.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, sign: sg, ts: i, sig: a } = pj.data;
  const chal = 'sibyx-referralstatus-v1|' + s + '|' + i;
  if (!authSigned(sg, chal, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
  const d = load(REFERRALS);
  const validated = Object.values(d).filter(x => x.inviter === s && (x.msgs || 0) >= MSG_NEED).length;
  const g = load(GRANTS);
  const gr = g[s];
  if (gr && gr.token) {
    const exp = Number(gr.exp) || 0;
    if (Math.floor(Date.now() / 1000) <= exp + 7 * 86400) {   // 中继宽限 7d
      return t.json({ ok: true, pro: true, token: gr.token, exp: exp, validated: validated });
    }
  }
  t.json({ ok: true, pro: false, validated: validated, need: REFERRAL_NEED, msgNeed: MSG_NEED });
});

module.exports = router;
