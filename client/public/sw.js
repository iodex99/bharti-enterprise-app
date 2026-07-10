/**
 * Minimal app-shell service worker.
 *
 * Rules (docs/ARCHITECTURE.md — the SW must never fight the self-update system):
 * - NEVER touches /api or /uploads — those always hit the network.
 * - index.html (navigations) is network-first, so a new release is picked up on the
 *   next load; the tiny cache only serves it when the office server is unreachable.
 * - Hashed build assets (/assets/*) are cache-first — safe because filenames change
 *   per build.
 */
const CACHE = 'bharti-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // live data + files: straight to network, no SW involvement at all
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  // navigations: network-first with cached fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // hashed assets: cache-first
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
