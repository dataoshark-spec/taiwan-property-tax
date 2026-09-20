const CACHE = "mortgage-calc-v20260919F";
/* 每個安裝路徑使用自己的快取；只處理本 App 的已知檔案，不代管其他工具。 */
const SCOPE = self.registration.scope;
const CACHE_KEY = CACHE + "::" + SCOPE;
const SHELL_CORE = ["./", "./index.html", "./sw.js", "./html2canvas.min.js", "./jspdf.umd.min.js"];
const SHELL_OPTIONAL = ["./icon-192.png", "./icon-180.png", "./icon-512.png"];
const SHELL_URLS = new Set(SHELL_CORE.concat(SHELL_OPTIONAL).map(function (path) { return new URL(path, SCOPE).href; }));
const HOME_URLS = new Set([new URL("./", SCOPE).href, new URL("index.html", SCOPE).href]);
const OFFLINE_HTML = "<!DOCTYPE html><html lang=\"zh-Hant\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Offline</title></head><body style=\"font-family:sans-serif;padding:2rem;text-align:center\"><h1>Offline</h1><p>Please reconnect and reopen the app.</p></body></html>";

function cacheEach(cache, urls) {
  return Promise.all(urls.map(function (url) {
    return cache.add(url).then(function () { return { url: url, ok: true }; })
      .catch(function (err) {
        console.error("[sw] 預快取失敗：" + url, err);
        return { url: url, ok: false };
      });
  }));
}

/* 舊版未把scope編入名稱。只有已知貸款快取名稱、含本scope的index，
   且其中所有URL都是本scope的已知殼層檔，才可確定為可清理的舊快取；無法判明就保留。 */
async function belongsToThisScope(name) {
  if (name.startsWith("mortgage-calc-v") && name.endsWith("::" + SCOPE)) return true;
  if (!/^mortgage-calc-v[0-9]{8}[A-Za-z0-9-]*$/.test(name)) return false;
  const old = await caches.open(name);
  if (!(await old.match(new URL("index.html", SCOPE).href))) return false;
  const keys = await old.keys();
  const ownUrls = new Set(SHELL_CORE.concat(SHELL_OPTIONAL).map(function (url) { return new URL(url, SCOPE).href; }));
  // root scope 的字串前綴也包含其他子路徑；混合 legacy 可能正供另一舊安裝使用。
  // 只有已知殼層檔案（可帶查詢參數）才足以證明全屬本安裝，其餘保守保留。
  return keys.length > 0 && keys.every(function (request) {
    const url = new URL(request.url); url.search = ""; url.hash = "";
    return ownUrls.has(url.href);
  });
}

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE_KEY).then(async function (cache) {
    const core = await cacheEach(cache, SHELL_CORE);
    const optional = await cacheEach(cache, SHELL_OPTIONAL);
    optional.filter(function (r) { return !r.ok; }).forEach(function (r) {
      console.warn("[sw] 非核心資源未快取（不影響离線試算與匯出）：" + r.url);
    });
    if (core.some(function (r) { return !r.ok; })) {
      // 只清除本次未完成的新快取；現有正常版本與其他工具都保留。
      await caches.delete(CACHE_KEY);
      throw new Error("core precache incomplete");
    }
    console.info("[sw] 預快取完成：" + CACHE_KEY);
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(async function (name) {
      if (name !== CACHE_KEY && await belongsToThisScope(name)) await caches.delete(name);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // 本 App 為固定靜態檔；版本等查詢參數共用同一份已驗證的殼層快取。
  url.search = ""; url.hash = "";
  const cacheUrl = url.href;
  // 在讀取任何快取之前排除其他路徑，舊快取殘留也不會被誤用。
  if (!SHELL_URLS.has(cacheUrl)) return;
  e.respondWith(caches.open(CACHE_KEY).then(async function (cache) {
    const cached = await cache.match(cacheUrl);
    if (cached) return cached;
    try {
      const response = await fetch(e.request);
      if (response && response.status === 200 && response.type !== "opaque") {
        e.waitUntil(cache.put(cacheUrl, response.clone()).catch(function (err) {
          console.warn("[sw] 資源快取失敗：" + e.request.url, err);
        }));
      }
      return response;
    } catch (err) {
      if (e.request.mode === "navigate" && HOME_URLS.has(cacheUrl)) {
        return await cache.match(new URL("index.html", SCOPE).href) || new Response(OFFLINE_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return Response.error();
    }
  }));
});
