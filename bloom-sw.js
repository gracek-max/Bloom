/* ============================================
   Bloom PWA Service Worker  — bloom-sw.js
   Place this file in the SAME folder as
   bloom-tracker-v7.html
   ============================================ */

const CACHE_NAME = 'bloom-v2';

/* Files to pre-cache on install */
const PRECACHE = [
  './bloom-tracker-v7.html',
  './bloom-sw.js',
];

/* ── Install: pre-cache app shell ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: cache-first for same-origin, network for external ── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  /* Skip non-GET requests */
  if (e.request.method !== 'GET') return;

  /* External (fonts, CDN) — network only, no caching */
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request)
        .then(res => {
          /* Only cache valid same-origin responses */
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          /* Offline fallback — serve cached app shell */
          return caches.match('./bloom-tracker-v7.html');
        });
    })
  );
});

/* ── Notification click: focus or open the app ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cls => {
        const open = cls.find(c => c.url.includes('bloom') || c.focused);
        if (open) return open.focus();
        if (cls.length > 0) return cls[0].focus();
        return clients.openWindow('./bloom-tracker-v7.html');
      })
  );
});
