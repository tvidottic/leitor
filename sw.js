// Service worker: deixa o aplicativo disponível offline (os livros ficam no IndexedDB).
const VERSION = 'leitor-v2';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/reader.js', './js/viewer.js', './js/library.js', './js/annotations.js', './js/translate.js',
  './js/panel.js', './js/vocab.js', './js/db.js', './js/utils.js', './js/cloud.js', './js/pdfsync.js', './js/ink.js', './js/pdf-writer.worker.js',
  './js/vendor/pdf.min.mjs', './js/vendor/pdf.worker.min.mjs', './js/vendor/pdf-lib.esm.min.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // APIs externas: rede direta
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(e.request);
    const network = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    if (cached) { network.catch(() => {}); return cached; }   // cache primeiro, atualiza em segundo plano
    const res = await network;
    return res || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
