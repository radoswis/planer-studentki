// Network-first: zawsze najnowsza wersja, gdy jest internet; offline – ostatnia zapisana
const C = 'planer-v3';
const CORE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(CORE))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== C).map(n => caches.delete(n))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    // do pamięci tylko poprawne odpowiedzi – błąd serwera nie nadpisze działającej kopii offline
    if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }
    // serwer ma chwilową awarię – pokaż ostatnią działającą wersję aplikacji
    return r.status >= 500 && e.request.mode === 'navigate' ? caches.match('/').then(c => c || r) : r;
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/').then(c => c || Response.error()) : Response.error()))));
});
