// Caches the app shell so WordDrill opens without internet.
// Bump the version whenever app files change (tests check that SHELL lists every js file).
const CACHE = 'worddrill-v26';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png',
  './js/app.js', './js/dates.js', './js/demo.js', './js/dropbox.js', './js/format.js', './js/markdown.js', './js/ops.js', './js/recall.js', './js/sync.js', './js/timer.js', './js/timer-ui.js', './js/versions.js'];

self.addEventListener('install', e => {
  // 'reload': straight from the server, not from the browser's HTTP cache (GitHub Pages allows 10 min)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;   // Dropbox requests are left alone
  // Network first (so updates arrive); offline — from the cache
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./'))));
});
