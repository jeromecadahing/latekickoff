/* Late Kick-off service worker
 * - Saves the app itself so it opens instantly, even offline.
 * - Fetches live data from ESPN first, falling back to the last saved copy
 *   when there's no signal.
 * Bump VERSION whenever you change any app file, so phones pick up the update. */
const VERSION = 'v13';
const APP_CACHE = `lko-app-${VERSION}`;
const DATA_CACHE = 'lko-data';
const APP_FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'channels.js', 'qrcode.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('lko-app-') && k !== APP_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live sports data: network first, saved copy if offline.
  // Old box scores are only read once and boiled down by the app, so don't keep copies.
  if (url.searchParams.has('lkobox')) return;

  if (url.hostname.endsWith('espn.com')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(DATA_CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then(r => r || Response.error()))
    );
    return;
  }

  // Fonts and team logos: use the saved copy, refresh it in the background.
  if (/fonts\.(googleapis|gstatic)\.com$|espncdn\.com$/.test(url.hostname)) {
    e.respondWith(
      caches.open(DATA_CACHE).then(async c => {
        const hit = await c.match(req);
        const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // The app itself: saved copy first, network as backup.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
  }
});
