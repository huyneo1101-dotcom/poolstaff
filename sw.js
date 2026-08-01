// PoolStaff — service worker
//  - App (same-origin): NETWORK-FIRST → luôn lấy bản mới khi có mạng, offline thì dùng cache.
//  - CDN/fonts (cross-origin): cache-first để chạy được offline.
//  - Supabase (API/realtime/storage): KHÔNG đụng — luôn đi thẳng mạng.
const CACHE = 'poolstaff-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Không cache Supabase (API/realtime/storage) — dữ liệu phải luôn mới.
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;

  if (url.origin === self.location.origin) {
    // App shell: network-first, fallback cache (offline).
    e.respondWith(
      fetch(req).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
    );
  } else {
    // CDN/fonts: cache-first, nạp mạng nếu chưa có.
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(r => {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
        return r;
      }).catch(() => m))
    );
  }
});
