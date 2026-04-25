// GSLPS Magic — service worker.
//
// Strategy: precache the entire app shell on install, serve from cache first,
// fall back to network. To force an update, bump CACHE_VERSION below; on the
// next page load the new SW will install and clean up the old caches.

const CACHE_VERSION = 'gslps-magic-v2';
const CACHE_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './roster.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
  // Precache and activate the new SW immediately so an update doesn't sit
  // around waiting for every tab to close.
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Clean up any caches from previous versions, then take over open clients.
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests.
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        // Opportunistically cache successful responses for next time.
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        // Offline + not in cache: best we can do is fall through.
        return cached;
      });
    })
  );
});
