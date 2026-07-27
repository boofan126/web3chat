// SPDX-License-Identifier: Apache-2.0
// SibyX 启动期脚本外置（原 index.html 内联块，启用严格 CSP 后必须外链，否则被 script-src 'self' 拦截）
// P0-#3 方案C：把首屏的 3 段内联 <script> 抽出到这里，index.html 仅 <script src="boot.js"> 引用。

// ① 匿名访问统计 beacon（cookieless：不写 cookie/localStorage，IP 由服务端哈希截断）
(function () {
  try {
    var RELAY_BASE = ''; // 不预置中继；与 app.js RELAY_URL 一致（空=未配置）。仅当配置了中继才上报匿名统计。
    var p = new URLSearchParams(location.search);
    var camp = p.get('ref') || p.get('utm_source') || 'direct';
    var ref = 'direct';
    try { if (location.referrer) ref = new URL(location.referrer).host; } catch (e) {}
    var payload = JSON.stringify({ path: location.pathname || '/', ref: ref, camp: camp });
    if (RELAY_BASE) {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(RELAY_BASE + '/track', new Blob([payload], { type: 'text/plain' }));
      } else {
        fetch(RELAY_BASE + '/track', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: payload, mode: 'no-cors' }).catch(function () {});
      }
    }
  } catch (e) {}
})();

// ② 欢迎页解码故障字标：乱码逐字解码定形为 SibyX（源自 Logo V3 动效）
(function () {
  var el = document.getElementById('welcomeDecode');
  if (!el) return;
  var TARGET = "SibyX";
  var POOL = "▓▒░#@%&*abcde0123456789<>/\\";
  el.classList.add('glitch');
  var frame = 0, holdUntil = 0;
  function rnd() { return POOL[(Math.random() * POOL.length) | 0]; }
  function tick() {
    var wel = document.getElementById('welcome');
    if (wel && wel.hidden) return;            // 进入应用后停止动画
    var now = Date.now();
    if (frame === 0 && holdUntil && now < holdUntil) {
      el.textContent = TARGET; setTimeout(tick, 140); return;
    }
    if (frame === 0) holdUntil = 0;
    frame++;
    var settled = Math.min(TARGET.length, (frame / 4) | 0);
    var out = "";
    for (var i = 0; i < TARGET.length; i++) { out += (i < settled) ? TARGET[i] : rnd(); }
    el.textContent = out;
    if (settled >= TARGET.length) { holdUntil = now + 2600; frame = 0; }
    setTimeout(tick, 70);
  }
  tick();
})();

// ③ PWA：注册 Service Worker（HTTPS 环境下生效；离线时缓存静态资源 + index.html 兜底）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js?v=21').catch(() => {}); });
}
