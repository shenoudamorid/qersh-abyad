const CACHE = 'masareef-v29';
const SHELL = ['./', './index.html', './logic.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

  // Fonts and other cross-origin assets: cache-first, then network, then cache them.
  if (new URL(req.url).origin !== location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => new Response('', { status: 504 })))
    );
    return;
  }

  // App shell: network-first so updates land, falling back to cache offline.
  // Only good answers replace the cache: if the site ever answers 404 (a renamed repo,
  // Pages switched off), the app keeps opening from its saved copy with all its data.
  const saved = () => caches.match(req).then(hit => hit || caches.match('./index.html'));
  e.respondWith(
    fetch(req).then(res => {
      if (!res.ok) return saved().then(hit => hit || res);
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(saved)
  );
});
