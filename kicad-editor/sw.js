// Offline support: network first, falling back to the last cached copy.
const CACHE = 'kicad-pad-v1';
const SHELL = ['./', './index.html', './style.css', './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png',
  './js/app.js', './js/sexpr.js', './js/draw.js', './js/pcb.js', './js/sch.js',
  './samples/led_indicator.kicad_sch', './samples/led_indicator.kicad_pcb'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))),
  );
});
