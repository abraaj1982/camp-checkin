// Camp Check-In App — Service Worker
// Caches only the app shell (this page + icons) so the app installs and
// launches instantly. All data requests (Google Apps Script / Google
// Sheets) always go to the network — check-in data must never be served
// from a stale cache.

const CACHE_NAME = 'camp-checkin-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept data calls — always hit the network fresh.
  const isDataCall = url.hostname.includes('script.google.com') ||
                      url.hostname.includes('docs.google.com') ||
                      url.hostname.includes('googleusercontent.com');
  if (isDataCall || event.request.method !== 'GET') {
    return;
  }

  // App shell: cache-first, falling back to network, then re-caching.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
