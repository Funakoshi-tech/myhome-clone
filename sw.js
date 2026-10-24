// sw.js — 公開した新しい版がすぐ反映されるようにする service worker。
// 同じサイトのファイル（HTML・JS・CSS・画像など）は毎回サーバーに更新の有無を確かめてから使う（ネットワーク優先）。
// 変わっていなければ 304 で済むので軽い。オフラインのときだけ、前回取得した内容を使う。
// three.js などの CDN はバージョン固定なので対象外（ブラウザのキャッシュに任せる）。

const CACHE = 'myhome-clone-offline-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    // no-cache: ブラウザのキャッシュがあっても、必ずサーバーに更新の有無を確かめる
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    // ページの移動でリダイレクトされた場合（/myhome-clone → /myhome-clone/ など）は、移動先の URL を開き直す
    if (req.mode === 'navigate' && res.redirected) return Response.redirect(res.url, 302);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}
