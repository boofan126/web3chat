// SPDX-License-Identifier: AGPL-3.0
// bot-run.js — 独立进程启动器（P1-⑦ supervisor 用）。
// 以「纯 Gun 客户端」身份直连官方中继（与 server 主 gun 经 mesh 同源），
// 不复用 server 进程的 Gun 实例，避免同进程多 Gun 实例共享模块级 state 互串成桥（#366 红线）。
// 崩溃 / 未捕获异常 → process.exit(1) → 由 server.js 的 startBotSupervisor 退避重拉。
'use strict';
const Gun = require('gun');

const PEER_ENV = process.env.SIBYX_BOT_PEERS
  || 'https://web3chat-e6or.onrender.com/gun,https://chat4hub-relay.onrender.com/gun';
const PEERS = PEER_ENV.split(',').map(s => s.trim()).filter(Boolean);

const gun = Gun({
  peers: PEERS,
  radisk: false,         // 机器人不落盘，纯客户端
  localStorage: false,
  multicast: false,
  ax: false               // 不接 radisk/axe，仅作中继客户端
});

const { startBot } = require('./bot.js');

startBot(gun, { gunFor: (sh) => gun })
  .then(() => console.log('[bot-run] startBot ready'))
  .catch(e => { console.error('[bot-run] startBot failed:', e && e.message); process.exit(1); });

// 未捕获异常统一转 exit(1)，交由 supervisor 重拉（而非静默死循环占坑）。
process.on('uncaughtException', (e) => { console.error('[bot-run] uncaughtException:', e && e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[bot-run] unhandledRejection:', e && (e.message || e)); process.exit(1); });
