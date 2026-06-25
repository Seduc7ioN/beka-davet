const CACHE = 'beka-davet-v16';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/og-image.jpg',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey: 'AIzaSyAVgSsLV4Td-6gFmNLmu_TLbJomESBDeX8',
    authDomain: 'bekadavet-bfe6f.firebaseapp.com',
    projectId: 'bekadavet-bfe6f',
    storageBucket: 'bekadavet-bfe6f.firebasestorage.app',
    messagingSenderId: '463318845796',
    appId: '1:463318845796:web:73e6a351af9bdbcb7e1271'
  });

  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const n = payload.notification || {};
    const data = payload.data || {};
    self.registration.showNotification(n.title || 'Beka Davet Hatırlatma', {
      body: n.body || data.body || 'Yeni bir hatırlatma var.',
      tag: data.tag || 'beka-reminders',
      data: { url: data.url || '/admin.html' },
      requireInteraction: true
    });
  });
} catch (err) {
  // Firebase Messaging desteklenmiyorsa PWA cache yine çalışmaya devam eder.
}

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

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data && e.notification.data.url ? e.notification.data.url : '/admin.html';
  e.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
      for (const client of list) {
        if (client.url.includes('/admin.html') && 'focus' in client) return client.focus();
      }
      return clients.openWindow(target);
    })
  );
});
