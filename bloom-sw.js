/* ============================================================
   Bloom PWA Service Worker  —  bloom-sw.js  v3
   Place this file in the SAME folder as index.html
   ============================================================ */

const CACHE = 'bloom-v3';

/* ── Everything the app needs to work 100% offline ── */
const PRECACHE_URLS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Pacifico&family=DM+Sans:wght@300;400;500;600;700&family=Comfortaa:wght@400;600;700&family=Quicksand:wght@400;500;600;700&family=Caveat:wght@400;600;700&family=Josefin+Sans:wght@400;600;700&family=Raleway:wght@400;600;700&family=Kalam:wght@400;700&family=Patrick+Hand&family=Poppins:wght@400;600;700&family=Outfit:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Space+Grotesk:wght@400;600;700&display=swap',
];

/* ── INSTALL: pre-cache app shell ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(
        PRECACHE_URLS.map(url =>
          c.add(url).catch(err => console.warn('[SW] skip:', url, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: delete old caches, claim clients ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => startAlarmLoop())
  );
});

/* ── FETCH: cache-first same-origin, network-first external ── */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isExternal = new URL(e.request.url).origin !== self.location.origin;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200)
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => null);

      if (isExternal) return net.then(r => r || cached || new Response('', {status:503}));
      if (cached) { net; return cached; } /* cache-first + background revalidate */
      return net.then(r => r || caches.match('./index.html'));
    })
  );
});

/* ── ALARM LOOP: checks every 60s even with screen off ── */
let _alarmInterval = null;
function startAlarmLoop() {
  if (_alarmInterval) clearInterval(_alarmInterval);
  checkAlarms();
  _alarmInterval = setInterval(checkAlarms, 60 * 1000);
}

function checkAlarms() {
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
    if (clients.length > 0) {
      clients[0].postMessage({ type: 'GET_SCHEDULES' });
    } else {
      getSchedulesFromIDB().then(s => { if (s) fireScheduledAlarms(s); });
    }
  });
}

/* ── MESSAGES from the app ── */
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SCHEDULES') {
    saveSchedulesToIDB(e.data.schedules);
    fireScheduledAlarms(e.data.schedules);
  }
  if (e.data.type === 'SAVE_SCHEDULES') {
    saveSchedulesToIDB(e.data.schedules);
    startAlarmLoop();
  }
  if (e.data.type === 'CANCEL_SCHEDULES') saveSchedulesToIDB([]);
});

function fireScheduledAlarms(schedules) {
  if (!Array.isArray(schedules)) return;
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowMins = now.getHours() * 60 + now.getMinutes();

  schedules.forEach(s => {
    if (!s.timeStr || s.completedToday) return;
    const [hh, mm] = s.timeStr.split(':').map(Number);
    const diff = nowMins - (hh * 60 + mm);
    if (diff >= 0 && diff < 2) {
      const key = `bloom_fired_${s.id}_${todayStr}_${s.timeStr}`;
      getIDB('bloom_fired').then(list => {
        const fired = list || [];
        if (!fired.includes(key)) {
          fired.push(key);
          setIDB('bloom_fired', fired);
          showAlarmNotification(s);
        }
      });
    }
  });
}

function showAlarmNotification(s) {
  const catEmoji = { task:'📌', health:'💪', reading:'📚', plan:'🗺️' };
  const emoji = catEmoji[s.cat] || '🌸';
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%237c3aed'/%3E%3Ctext y='.85em' font-size='68' x='10'%3E🌸%3C/text%3E%3C/svg%3E";
  return self.registration.showNotification(`${emoji} ${s.name}`, {
    body: s.desc || `Time for your ${s.cat} reminder! Keep it up 💪`,
    icon, badge: icon,
    tag: `bloom-${s.id}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [200, 100, 200, 100, 400],
    data: { itemId: s.id },
    actions: [
      { action: 'done',   title: '✅ Mark Done'   },
      { action: 'snooze', title: '⏱ Snooze 15min' },
    ],
  });
}

/* ── NOTIFICATION CLICK ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const itemId = e.notification.data && e.notification.data.itemId;

  if (e.action === 'snooze') {
    e.waitUntil(
      getSchedulesFromIDB().then(schedules => {
        const item = (schedules || []).find(s => s.id === itemId);
        if (item) setTimeout(() => showAlarmNotification(item), 15 * 60 * 1000);
      })
    );
    return;
  }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (e.action === 'done' && clients.length > 0) {
        clients[0].postMessage({ type: 'MARK_DONE', itemId });
        return clients[0].focus();
      }
      const open = clients.find(c => c.url.includes('index') || c.url.endsWith('/'));
      if (open) return open.focus();
      const url = e.action === 'done'
        ? `./index.html?action=done&id=${itemId}`
        : './index.html';
      return self.clients.openWindow(url);
    })
  );
});

/* ── INDEXEDDB (SW cannot use localStorage) ── */
const IDB_NAME = 'bloom-sw', IDB_VER = 1, IDB_STORE = 'kv';

function openIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, IDB_VER);
    r.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
function getIDB(key) {
  return openIDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get(key);
    r.onsuccess = e => res(e.target.result ?? null);
    r.onerror   = e => rej(e.target.error);
  }));
}
function setIDB(key, val) {
  return openIDB().then(db => new Promise((res, rej) => {
    const r = db.transaction(IDB_STORE,'readwrite').objectStore(IDB_STORE).put(val, key);
    r.onsuccess = () => res();
    r.onerror   = e => rej(e.target.error);
  }));
}
function getSchedulesFromIDB() { return getIDB('bloom_schedules').catch(() => null); }
function saveSchedulesToIDB(s) { return setIDB('bloom_schedules', s).catch(console.warn); }
