// 最小 Service Worker — 滿足 Chrome PWA 安裝條件 + 離線快取
const CACHE_PREFIX = 'fwTax-' + encodeURIComponent(self.registration.scope) + '-';
const CACHE = CACHE_PREFIX + '2026.09.11A';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// 舊版未區分安裝路徑；僅清理由本 APP 靜態路徑構成的舊快取。
async function isOwnOldCache(key) {
  if (key === CACHE) return false;
  if (key.startsWith(CACHE_PREFIX)) return true;
  if (!/^fwTax-(?:v\d+|\d{4}\.\d{2}\.\d{2}[A-Z]+)$/.test(key)) return false;
  const paths = new Set(ASSETS.map(asset => new URL(asset, self.registration.scope).pathname));
  const requests = await (await caches.open(key)).keys();
  return requests.length > 0 && requests.every(request => {
    const url = new URL(request.url);
    return url.origin === self.location.origin && paths.has(url.pathname);
  });
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (await isOwnOldCache(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// 只有本 APP 的文件入口可在斷網時使用已安裝的頁面。
async function offlineDocument(request, error) {
  const url = new URL(request.url);
  const entry = new URL('./', self.registration.scope);
  const index = new URL('./index.html', self.registration.scope);
  if (request.mode === 'navigate' && url.origin === entry.origin &&
      (url.pathname === entry.pathname || url.pathname === index.pathname)) {
    const response = await (await caches.open(CACHE)).match(index.href);
    if (response) return response;
  }
  throw error;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(cache => cache.match(e.request)).then(cached => 
      cached || fetch(e.request).then(res => {
        // 動態快取(同源 only)
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(error => offlineDocument(e.request, error))
    )
  );
});
