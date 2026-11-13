/* Gilman Sales Leads service worker. Bump CACHE on every app release. */
const CACHE = 'sales-leads-v3';
const DATA = 'sales-leads-data.json';
const ASSETS = ['./', 'index.html', 'offline.html', 'app.css', 'app.js', 'manifest.webmanifest', DATA,
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // only remove this app's own older caches
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('sales-leads-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  // data file: network-first so the daily publish shows up right away; cached copy when offline
  if (u.pathname.endsWith('/' + DATA)) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(DATA, copy)); }
      return res;
    }).catch(async () => {
      const c = await caches.open(CACHE);
      return (await c.match(DATA)) || (await c.match(req, { ignoreSearch: true })) || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }
  // app shell: cache-first, refreshed in the background
  e.respondWith(caches.open(CACHE).then(async c => {
    const nav = req.mode === 'navigate';
    const hit = await c.match(req, { ignoreSearch: true }) || (nav ? await c.match('index.html') : null);
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || (nav ? await c.match('offline.html') : null) || new Response('Offline', { status: 503 });
  }));
});
