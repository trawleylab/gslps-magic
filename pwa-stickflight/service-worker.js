// Stick Flight — service worker.
//
// Strategy: precache the entire app shell on install, serve from cache first,
// fall back to network. To force an update, bump CACHE_VERSION below; on the
// next page load the new SW will install and clean up the old caches.
//
// The vendored Three.js (vendor/three.min.js) MUST be precached — without it
// the game cannot run offline.

const CACHE_VERSION = 'stickflight-v4';
// The JS/CSS carry a ?v= cache-buster (see index.html) so a version bump always
// fetches fresh past any HTTP cache. Precache the SAME queried URLs the page
// requests so the first offline load still has them.
const CACHE_FILES = [
  './',
  './index.html',
  './styles.css?v=4',
  './flight.js?v=4',
  './app.js?v=4',
  './manifest.json',
  './vendor/three.min.js',
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
