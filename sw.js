// Offline support: network first, cached copy when offline.
// Bump VERSION when the precache list changes.
const VERSION = 'v3';
const CACHE = `converter-${VERSION}`;
const PRECACHE = [
  '/',
  '/index.html',
  '/assets/site.css',
  '/assets/js/core.js',
  '/assets/js/jpeg.js',
  '/assets/js/resize.js',
  '/assets/js/gif.js',
  '/assets/js/splitter.js',
  '/assets/js/grid.js',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-192.png',
  '/pages/converters/png-to-jpeg.html',
  '/pages/converters/png-stickers.html',
  '/pages/converters/png-icons.html',
  '/pages/converters/gif-to-webm.html',
  '/pages/converters/image-splitter.html',
  '/pages/converters/grid-generator.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('/')))
  );
});
