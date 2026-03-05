/* ============================================================
   Bloom PWA Service Worker  —  bloom-sw.js  v5
   ============================================================
   HOW ALARMS WORK:
   1. App computes exact fireAt (UTC ms) for each reminder
      and sends them to SW via postMessage SAVE_SCHEDULES.
   2. SW stores them in IndexedDB (survives SW restart).
   3. SW sets a self.setTimeout per alarm wrapped in a
      ExtendableEvent.waitUntil promise — this tells the
      browser "keep me alive until this resolves".
   4. On Android/iOS the SW may still be killed for long
      delays. The SW re-arms itself on every wake event
      (fetch, message, notificationclick, sync).
   5. A background-sync tag 'bloom-alarm-check' is
      registered by the app every time schedules are saved —
      this wakes the SW even with the screen off on Android.
   ============================================================ */

const CACHE = 'bloom-v5';
const PRECACHE = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Pacifico&family=DM+Sans:wght@300;400;500;600;700&family=Comfortaa:wght@400;600;700&family=Quicksand:wght@400;500;600;700&family=Caveat:wght@400;600;700&family=Josefin+Sans:wght@400;600;700&family=Raleway:wght@400;600;700&family=Kalam:wght@400;700&family=Patrick+Hand&family=Poppins:wght@400;600;700&family=Outfit:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Space+Grotesk:wght@400;600;700&display=swap',
];

/* ── INSTALL ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(
        PRECACHE.map(u => c.add(u).catch(err => console.warn('[SW] skip:', u, err)))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => armAllAlarms())          /* re-arm after SW restart */
  );
});

/* ── FETCH: cache-first same-origin, network-first external ── */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const ext = new URL(e.request.url).origin !== self.location.origin;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request)
        .then(r => { if(r && r.status===200) caches.open(CACHE).then(c=>c.put(e.request,r.clone())); return r; })
        .catch(() => null);
      if (ext)    return net.then(r => r || cached || new Response('',{status:503}));
      if (cached) { net; return cached; }
      return net.then(r => r || caches.match('./index.html'));
    })
  );
});

/* ── BACKGROUND SYNC: wakes SW on Android even with screen off ── */
self.addEventListener('sync', e => {
  if (e.tag === 'bloom-alarm-check') {
    e.waitUntil(armAllAlarms());
  }
});

/* ── PERIODIC SYNC (Chrome Android, every ~1hr minimum) ── */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'bloom-periodic') {
    e.waitUntil(armAllAlarms());
  }
});

/* ── MESSAGES from the app ── */
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SAVE_SCHEDULES') {
    e.waitUntil(
      saveIDB('bloom_schedules', e.data.schedules)
        .then(() => armAllAlarms())
    );
  }

  if (e.data.type === 'CANCEL_SCHEDULES') {
    cancelAllTimers();
    e.waitUntil(saveIDB('bloom_schedules', []));
  }
});

/* ════════════════════════════════════════════
   ALARM ENGINE
   ════════════════════════════════════════════ */
const _timers = new Map();

function cancelAllTimers() {
  _timers.forEach(id => clearTimeout(id));
  _timers.clear();
}

function armAllAlarms() {
  return getIDB('bloom_schedules').then(schedules => {
    if (!Array.isArray(schedules) || !schedules.length) return;

    cancelAllTimers();

    const now = Date.now();

    /* Return a promise that resolves when ALL alarms have fired or been skipped.
       This is what keeps the SW alive via waitUntil. */
    const promises = schedules
      .filter(s => s.fireAt && !s.completedToday)
      .map(s => {
        const delay = s.fireAt - now;

        /* Already passed — fire immediately if within last 2 minutes */
        if (delay <= 0) {
          if (delay > -2 * 60 * 1000) return maybeFireAlarm(s);
          return Promise.resolve();   /* too old, skip */
        }

        /* Future alarm — set timer, keep SW awake with a long-lived promise */
        return new Promise(resolve => {
          const tid = setTimeout(() => {
            _timers.delete(s.fireAt + s.id);
            maybeFireAlarm(s).then(resolve);
          }, delay);
          _timers.set(s.fireAt + s.id, tid);
        });
      });

    /* waitUntil on all of them collectively */
    return Promise.all(promises);
  }).catch(err => console.warn('[SW] armAllAlarms error:', err));
}

function maybeFireAlarm(s) {
  /* Deduplicate: only fire once per (id, fireAt) */
  const dedupKey = `bloom_fired_${s.id}_${s.fireAt}`;
  return getIDB(dedupKey).then(alreadyFired => {
    if (alreadyFired) return;
    return saveIDB(dedupKey, true).then(() => fireNotification(s));
  });
}

function fireNotification(s) {
  const catEmoji = { task:'📌', health:'💪', reading:'📚', plan:'🗺️' };
  const emoji = catEmoji[s.cat] || '🌸';

  /* Inline SVG icon — must be URL-encoded, no backtick/unescaped quotes */
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%237c3aed'/%3E%3Ctext x='50%25' y='54%25' font-size='58' text-anchor='middle' dominant-baseline='middle'%3E%F0%9F%8C%B8%3C/text%3E%3C/svg%3E";

  return self.registration.showNotification(`${emoji} ${s.name}`, {
    body:               s.desc || `It's time for your ${s.cat} reminder! 💪`,
    icon,
    badge:              icon,
    tag:                `bloom-${s.id}`,
    renotify:           true,        /* always sound/vibrate even if same tag */
    requireInteraction: true,        /* stay on screen until dismissed */
    silent:             false,       /* use device notification sound */
    vibrate:            [400, 200, 400, 200, 800],
    data:               { itemId: s.id, schedule: s },
    actions: [
      { action: 'done',   title: '✅ Done'       },
      { action: 'snooze', title: '⏱ Snooze 15m'  },
    ],
  }).catch(err => console.warn('[SW] showNotification failed:', err));
}

/* ── NOTIFICATION CLICK ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { itemId, schedule } = e.notification.data || {};

  if (e.action === 'snooze' && schedule) {
    const snoozed = { ...schedule, fireAt: Date.now() + 15 * 60 * 1000 };
    e.waitUntil(
      getIDB('bloom_schedules').then(list => {
        const updated = (list || []).concat(snoozed);
        return saveIDB('bloom_schedules', updated).then(() => armAllAlarms());
      })
    );
    return;
  }

  if (e.action === 'done') {
    e.waitUntil(
      self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => {
        if (cs.length) { cs[0].postMessage({ type:'MARK_DONE', itemId }); return cs[0].focus(); }
        return self.clients.openWindow(`./index.html?action=done&id=${itemId}`);
      })
    );
    return;
  }

  /* Tap notification body — open app */
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => {
      const open = cs.find(c => c.url.endsWith('/') || c.url.includes('index'));
      if (open) return open.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

/* ════════════════════════════════════════════
   INDEXEDDB HELPERS
   ════════════════════════════════════════════ */
const DB_NAME = 'bloom-sw-db', DB_VER = 1, DB_STORE = 'kv';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = ev => ev.target.result.createObjectStore(DB_STORE);
    r.onsuccess = ev => res(ev.target.result);
    r.onerror   = ev => rej(ev.target.error);
  });
}
function getIDB(key) {
  return openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(DB_STORE,'readonly').objectStore(DB_STORE).get(key);
    r.onsuccess = ev => res(ev.target.result ?? null);
    r.onerror   = ev => rej(ev.target.error);
  }));
}
function saveIDB(key, val) {
  return openDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(DB_STORE,'readwrite').objectStore(DB_STORE).put(val, key);
    r.onsuccess = () => res();
    r.onerror   = ev => rej(ev.target.error);
  }));
}
