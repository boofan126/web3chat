// Copyright (c)2026 sibyx & Litao Fan — SibyX 非商用，须署名，详见 LICENSE
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
    const i = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: o, y: n }, format: 'jwk', dsaEncoding: 'ieee-p1363' });
    return crypto.verify('sha256', Buffer.from(t, 'utf8'), i, Buffer.from(s, 'base64'));
  } catch (r) { return false; }
}
// 统一签名校验：signB64=原始65B公钥(base64)、msg=待验明文、sigB64=签名、expectedAddr=期望地址、ts=客户端时间戳(ms)
// 防：缺字段 / 时间戳重放(>5min) / 公钥地址不匹配 / 签名无效。复用 deriveAddress+verifySig。
function authSigned(signB64, msg, sigB64, expectedAddr, ts) {
  try {
    if (!signB64 || !msg || !sigB64 || !expectedAddr || !ts) return false;
    if (Math.abs(Date.now() - Number(ts)) > 300000) return false;
    if (deriveAddress(signB64) !== expectedAddr) return false;
    return verifySig(signB64, msg, sigB64);
  } catch (e) { return false; }
}
const CHALLENGE = (r, t) => 'sibyx-pubkey-v1|' + r + '|' + t;

router.post('/pubkey', async (r, t) => {
  const p = pubkeyPostSchema.safeParse(r.body || {});
  if (!p.success) return t.status(400).json({ ok: false, err: 'invalid_params' });
  const { addr: s, sign: e, dh: o, nick: n, ts: i, sig: a } = p.data;
  let u;
  try { u = deriveAddress(e); } catch (r) { return t.status(400).json({ ok: false, err: 'bad_sign_pub' }); }
  if (u !== s) return t.status(403).json({ ok: false, err: 'addr_mismatch' });
  if (!verifySig(e, CHALLENGE(s, i), a)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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
  if (!authSigned(sg, s + '|' + i + '|' + e, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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
  if (!authSigned(sg, s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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
  if (!authSigned(sg, e + '|' + s + '|' + i, a, e, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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
  if (!authSigned(sg, s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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
  if (!authSigned(sg, s + '|' + i, a, s, i)) return t.status(403).json({ ok: false, err: 'bad_sig' });
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

module.exports = router;
