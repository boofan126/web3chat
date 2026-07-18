// SibyX Service Worker（PWA 离线壳）
// 策略：Stale-While-Revalidate —— 缓存优先即时响应，后台静默更新。
//   - 前端静态资源（app.js/styles.css/gun.js 等）离线可用
//   - /gun WebSocket 代理、/healthz、/api 不缓存（直通网络）
//   - 导航请求回退到 index.html（SPA 兜底）
const CACHE = 'sibyx-v2';

// 需要预缓存的静态文件列表（与 build.cjs COPY 清单同步）
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/gun.js',
  '/wordlist.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 只处理同源 GET 请求
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  // Gun 中继、健康检查、API、server-side 路由不碰
  if (u.pathname.startsWith('/gun')) return;
  if (u.pathname === '/healthz' || u.pathname.startsWith('/api/')) return;
  e.respondWith(swr(req));
});

// Stale-While-Revalidate：
//   有缓存 → 先返回旧缓存（秒开），同时后台拉取最新版更新缓存。
//   无缓存 → 拉网络；导航请求失败时回退到 index.html。
async function swr(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  // 后台更新（不阻塞响应）
  const netP = fetch(req).then((res) => {
    if (res && res.status === 200) { cache.put(req, res.clone()); }
    return res;
  }).catch(() => null);

  // 导航请求无缓存时，尝试网络；若离线则返回缓存的 index.html
  if (!cached && req.mode === 'navigate') {
    const nav = await netP;
    return nav || cache.match('/index.html');
  }

  return cached || netP;
}
