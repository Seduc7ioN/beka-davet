const CACHE = 'beka-davet-v5';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => {
      return new Request(u, {cache: 'reload'});
    })).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/admin.html')) return;
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(new Request(e.request, {cache: 'reload'}))
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('/index.html', clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
