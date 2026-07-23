// SPDX-License-Identifier: AGPL-3.0
/**
 * SibyX-AI 机器人（同 Dyno 共部署，复用 server.js 的 Gun peer）
 * ------------------------------------------------------------------
 * 决策（用户拍板 2026-07-22）：
 *   1) 每日北京时间 04:00 自动在指定频道发「今日提示」（静态轮播 tips.json）
 *   2) P1 静态 FAQ 规则回复（faq.json 关键词匹配，无 LLM 调用）
 *   3) 仅「用户主动 @SibyX-AI 的频道消息」或「主动私聊机器人」才回复（可控）
 *   4) 前端对机器人地址打「官方 AI」认证角标（见 app.js isBotMsg）
 *   5) 与 web3chat 服务同进程 / 同 Dyno 部署，共享 Gun 实例
 *   6) 2026-07-23：welcome 频道人类消息共享上限 50 条 + 机器人消息独立上限 30 条（均滚动删最旧，控制全域广播数量，避免机器人主导频道）
 *
 * E2EE 边界：频道消息明文签名；私聊消息用机器人 ECDH 私钥 + 对方 ECDH 公钥
 * 派生 AES-GCM 加密（与 app.js 完全一致的 wire 格式），私钥不出端。
 */
'use strict';
const fs = require('fs');
const path = require('path');
if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto; // 老 Node 兜底 WebCrypto
const SDK = require('../sdk/sibyx-sdk.js');

/* ---------- 固定身份（与前端 BOT_ADDRESS 必须一致） ---------- */
const BOT_MNEMONIC = process.env.SIBYX_BOT_MNEMONIC
  || 'nuclear decline lunar concert excite wrist praise adult shadow exotic harvest walk';
const BOT_ADDRESS = '0xbf481cf21d3a33a416c228b36cffea54a6f5935b'; // 由上面助记词派生，勿改
const BOT_NICK = 'SibyX-AI';
const BOT_CHANNEL = process.env.SIBYX_BOT_CHANNEL || 'welcome'; // 每日提示发布的频道（与 app 默认落地频道一致，修掉旧 bot->general / app->global 不一致）
const MENTION = '@sibyx-ai'; // 频道触发词（大小写不敏感）
const REPLY_COOLDOWN_MS = 5000; // 每用户限频窗口
const WELCOME_CAP = 50;      // welcome 频道人类消息共享上限（控制全域广播数量；超则滚动删最旧）
const BOT_CAP = 30;         // welcome 频道机器人消息独立上限（避免机器人自身消息无限累积主导频道）

/* ---------- 运行态 ---------- */
let gun = null;
let botRec = null;
let signPriv = null; // CryptoKey（ECDSA 签名私钥）
let dhPriv = null;   // CryptoKey（ECDH 私钥，用于私聊加密）
let botStartTime = 0;
const repliedIds = new Set();    // 已回复消息 id，防 Gun 重放重复回复
const replyFingerprints = new Map(); // "addr:text前30字符" -> ts（内容级去重，防不同id但同内容）
const FINGERPRINT_TTL_MS = 15000;   // 内容指纹窗口：同一用户相同内容15秒内不重复回复
const lastReplyByUser = new Map(); // addr -> 上次回复时间戳（限频）
const peerDhCache = new Map();    // addr -> dhPub（缓存，便于私聊加密）
const welcomeMsgs = new Map();    // id -> ts：welcome 频道人类消息（共享上限追踪）
const botMsgs = new Map();       // id -> ts：welcome 频道机器人消息（独立上限追踪）

/* ---------- 数据文件 ---------- */
function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')); }
  catch (e) { console.error('[bot] load ' + name + ' failed:', e.message); return fallback; }
}
let TIPS = loadJson('tips.json', ['SibyX 今日提示：保持好奇心，消息端到端加密，只有你和对方能读。']);
let FAQ = loadJson('faq.json', {});

/* ---------- 启动 ---------- */
async function startBot(gunInstance) {
  try {
    gun = gunInstance;
    botRec = await SDK.identityFromMnemonic(BOT_MNEMONIC);
    // 校验：派生地址必须与硬编码一致（防止助记词/环境变量被改导致冒充角标错位）
    if (botRec.address !== BOT_ADDRESS) {
      console.error('[bot] FATAL: derived address ' + botRec.address + ' != hardcoded ' + BOT_ADDRESS + ' — check BOT_MNEMONIC');
      return;
    }
    const subtle = globalThis.crypto.subtle;
    signPriv = await subtle.importKey('jwk', botRec.signPrivJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    dhPriv = await subtle.importKey('jwk', botRec.dhPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    botStartTime = Date.now();
    console.log('[bot] SibyX-AI started | addr=' + botRec.address + ' | daily #' + BOT_CHANNEL + ' @ 04:00 Asia/Shanghai');
    subscribeMessages();
    scheduleDaily();
  } catch (e) {
    console.error('[bot] failed to start:', e && e.stack || e);
  }
}

/* ---------- 订阅全量消息总线 ---------- */
function subscribeMessages() {
  gun.get('web3chat').map().on(async (data, key) => {
    try { await handleIncoming(data, key); } catch (e) { /* 单条失败不拖垮订阅 */ }
  });
}

/* ---------- 消息分发 ---------- */
async function handleIncoming(data, key) {
  const id = (key != null) ? String(key) : (data && data.id);
  // 墓碑检测：删除节点（put(null) 或仅含 _ 元数据）-> 从上限追踪移除
  if (!data || typeof data !== 'object' || !data.kind) {
    if (id) { welcomeMsgs.delete(id); botMsgs.delete(id); }
    return;
  }
  if (data.ts == null) return;
  if (!id) return;
  // ---- welcome 频道上限追踪（必须在回放守卫之前，以便重启时重建计数）----
  // 人类消息与机器人消息分别计入各自上限：机器人消息也滚删，避免频道被机器人主导
  if (data.kind === 'channel' && data.ctx === 'welcome' && data.address) {
    if (data.address === BOT_ADDRESS) { botMsgs.set(id, data.ts || 0); enforceBotCap(); }
    else { welcomeMsgs.set(id, data.ts || 0); enforceWelcomeCap(); }
  }
  if (data.address === BOT_ADDRESS) return;     // 自己的消息不参与回复逻辑（防重/限频/回放）
  if (data.ts < botStartTime - 5000) return;  // 忽略启动前的历史回放，避免刷屏/误回复

  // 好友请求：自动接受（让用户可将机器人加为好友后私聊）
  if (data.kind === 'fr_req' && data.target === BOT_ADDRESS) {
    const ok = await SDK.verifyMessage(data.sign, data.from + '|' + data.target + '|' + data.ts, data.sig).catch(() => false);
    if (ok && data.dh) { peerDhCache.set(data.from, data.dh); await sendFriendAck(data.from); }
    return;
  }

  const isDM = data.kind === 'dm';
  const isChannel = data.kind === 'channel';
  if (!isDM && !isChannel) return;

  // 取明文
  let text = '';
  if (isDM) {
    if (data.peer !== BOT_ADDRESS) return;   // 不是发给机器人的私聊，忽略
    if (data.dhPub) peerDhCache.set(data.address, data.dhPub);
    if (!data.iv || !data.cipher) return;
    try {
      const aes = await SDK.deriveAES(dhPriv, data.dhPub);
      const plain = await SDK.decryptText(aes, data.iv, data.cipher);
      try { text = (JSON.parse(plain)).text || ''; } catch (e) { text = plain; }
    } catch (e) { return; }
  } else {
    text = data.text || '';
  }
  if (!text) return;

  // 触发条件：频道需 @SibyX-AI；私聊只要发给机器人即视为主动私聊
  const mentioned = text.toLowerCase().includes(MENTION);
  if (isChannel && !mentioned) return;

  // 限频
  const now = Date.now();
  const last = lastReplyByUser.get(data.address) || 0;
  if (now - last < REPLY_COOLDOWN_MS) return;

  // 原子去重（ID级）：所有同步验证通过后、首个 await 之前标记，防止 Gun 重放并发触发多次回复
  // （不能放在函数入口：Gun 首次回调 data 不完整会提前 return 但消费 ID，导致完整回调被误判为重复）
  if (repliedIds.has(data.id)) return;
  repliedIds.add(data.id);
  if (repliedIds.size > 5000) repliedIds.clear();

  const answer = pickAnswer(text);

  // 内容级去重（双保险）：同一用户 + 相同提问内容 + 短窗口内 → 不重复回复
  // 覆盖场景：Gun 多 peer 延迟送达（id相同已被上面拦截）、部署滚动新旧实例各回一条等
  const fp = data.address + ':' + (text || '').slice(0, 30).toLowerCase().trim();
  const fpTs = replyFingerprints.get(fp) || 0;
  if (now - fpTs < FINGERPRINT_TTL_MS) return; // 窗口内已回过相似内容
  replyFingerprints.set(fp, now);
  // 定期清理过期指纹（避免内存泄漏）
  if (replyFingerprints.size > 1000) {
    const cutoff = now - FINGERPRINT_TTL_MS;
    for (const [k, v] of replyFingerprints) { if (v < cutoff) replyFingerprints.delete(k); }
  }

  if (isDM) await sendDmReply(data, answer);
  else await sendChannelReply(data, answer);

  lastReplyByUser.set(data.address, now);
}

/* ---------- FAQ 关键词匹配（P1 静态）+ 按提问语言路由 ---------- */
// 含中日韩统一表意文字（中文）即视为中文提问；其余语言一律走英文回复
function hasCJK(s) { return /[一-鿿]/.test(s || ''); }

function pickAnswer(text) {
  const raw = (text || '');
  const zh = hasCJK(raw);                       // 是否中文提问
  // 先剥离提及串（@SibyX-AI 含 "ai"，不剥离会污染关键词匹配）
  const t = raw.toLowerCase().replace(new RegExp(MENTION, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  const tbl = zh ? (FAQ.zh || {}) : (FAQ.en || {}); // 中文→中文表，其他→英文表
  for (const key of Object.keys(tbl)) {
    if (key && t.includes(key.toLowerCase())) return tbl[key];
  }
  const d = FAQ.__default__ || {};
  return zh ? (d.zh || '') : (d.en || '');     // 兜底也按语言
}

/* ---------- welcome 频道共享上限（控制全域广播数量） ---------- */
function enforceWelcomeCap() {
  if (welcomeMsgs.size <= WELCOME_CAP) return;
  const sorted = [...welcomeMsgs.entries()].sort((a, b) => a[1] - b[1]); // 按 ts 升序，最旧在前
  while (welcomeMsgs.size > WELCOME_CAP) {
    const oldestId = sorted.shift()[0];
    welcomeMsgs.delete(oldestId);
    try { gun.get('web3chat').get(oldestId).put(null); } catch (e) { /* 墓碑删除失败不致命 */ }
  }
}

/* ---------- welcome 频道机器人消息独立上限 ---------- */
function enforceBotCap() {
  if (botMsgs.size <= BOT_CAP) return;
  const sorted = [...botMsgs.entries()].sort((a, b) => a[1] - b[1]); // 按 ts 升序，最旧在前
  while (botMsgs.size > BOT_CAP) {
    const oldestId = sorted.shift()[0];
    botMsgs.delete(oldestId);
    try { gun.get('web3chat').get(oldestId).put(null); } catch (e) { /* 墓碑删除失败不致命 */ }
  }
}

/* ---------- 写链（与 app.js buildWire 等价） ---------- */
function writeWire(id, msg) {
  try {
    gun.get('web3chat').get(id).put(msg);
    console.log('[bot] sent ' + msg.kind + ' -> #' + (msg.ctx || '') + ' : ' + (msg.text || '(cipher)'));
  } catch (e) {
    console.error('[bot] write failed:', e && e.message);
  }
}

async function sendChannelReply(data, answer) {
  const ctx = data.ctx;
  if (!ctx) return;
  const id = globalThis.crypto.randomUUID();
  const ts = Date.now();
  const sig = await SDK.signMessage(signPriv, answer);
  writeWire(id, {
    id, kind: 'channel', ctx,
    address: BOT_ADDRESS, pubRawB64: botRec.signPubB64, dhPub: botRec.dhPubB64,
    nick: BOT_NICK, ts, text: answer, sig
  });
}

async function sendDmReply(data, answer) {
  const peerAddr = data.address;          // 对方地址
  const peerDhPub = data.dhPub;          // 对方 ECDH 公钥（来自该条私聊消息）
  if (!peerDhPub) return;
  const ctx = await SDK.dmRoomId(BOT_ADDRESS, peerAddr);
  const aes = await SDK.deriveAES(dhPriv, peerDhPub);
  const bundle = JSON.stringify({ text: answer, file: null });
  const { iv, cipher } = await SDK.encryptText(aes, bundle);
  const id = globalThis.crypto.randomUUID();
  const ts = Date.now();
  const sig = await SDK.signMessage(signPriv, cipher);
  writeWire(id, {
    id, kind: 'dm', ctx, peer: peerAddr,
    address: BOT_ADDRESS, pubRawB64: botRec.signPubB64, dhPub: botRec.dhPubB64, peerDhPub,
    nick: BOT_NICK, ts, iv, cipher, sig
  });
}

/* ---------- 自动接受好友请求 ---------- */
async function sendFriendAck(from) {
  const ts = Date.now();
  const sig = await SDK.signMessage(signPriv, BOT_ADDRESS + '|' + from + '|ack|' + ts);
  gun.get('web3chat').get('friendack').get(from).get(BOT_ADDRESS).put({ from: BOT_ADDRESS, to: from, sign: botRec.signPubB64, ts, sig });
  const id = globalThis.crypto.randomUUID();
  gun.get('web3chat').get(id).put({ id, kind: 'fr_ack', from: BOT_ADDRESS, to: from, sign: botRec.signPubB64, ts, sig });
  console.log('[bot] accepted friend request from ' + from);
}

/* ---------- 每日提示（北京时间 04:00 = UTC 20:00，Asia/Shanghai 固定 +8 无夏令时） ---------- */
async function postDailyTip() {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const tip = TIPS[dayIndex % TIPS.length];
  const id = globalThis.crypto.randomUUID();
  const ts = Date.now();
  const sig = await SDK.signMessage(signPriv, tip);
  writeWire(id, {
    id, kind: 'channel', ctx: BOT_CHANNEL,
    address: BOT_ADDRESS, pubRawB64: botRec.signPubB64, dhPub: botRec.dhPubB64,
    nick: BOT_NICK, ts, text: tip, sig
  });
  console.log('[bot] daily tip posted to #' + BOT_CHANNEL);
}

function msUntilNextUTC20() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1); // 已过今天 20:00 UTC → 明天
  return next.getTime() - now.getTime();
}
function scheduleDaily() {
  const delay = msUntilNextUTC20();
  console.log('[bot] next daily tip in ' + Math.round(delay / 60000) + ' min (04:00 Asia/Shanghai)');
  setTimeout(async () => {
    try { await postDailyTip(); } catch (e) { console.error('[bot] daily tip error', e && e.message); }
    scheduleDaily(); // 自纠正递归，不依赖外部 cron 依赖
  }, delay);
}

module.exports = { startBot, _test: { pickAnswer, msUntilNextUTC20, _setGun: (g) => { gun = g; }, welcomeMsgs, botMsgs, handleIncoming } };
