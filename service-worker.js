// Bump VERSION on every release so devices pick up the new files.
const VERSION = 'v9';
const CACHE_NAME = 'sss-invoice-' + VERSION;
const LOCAL = [
  './', './index.html', './css/style.css?v=9', './js/images.js?v=9', './js/app.js?v=9', './js/ui.js?v=9',
  './data.js', './manifest.json', './icon-192.png', './icon-512.png'
];
// Third-party libraries cached too, so PDF / Excel export also works offline.
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await Promise.all(LOCAL.map((u) => cache.add(u).catch(() => {})));
    await Promise.all(CDN.map((u) => cache.add(new Request(u, { mode: 'no-cors' })).catch(() => {})));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Stale-while-revalidate: open instantly from cache, refresh in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN.indexOf(req.url) !== -1 || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isCdn) return; // Firebase realtime traffic etc. is not touched
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: false });
    const net = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque') && res.status !== 206) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
