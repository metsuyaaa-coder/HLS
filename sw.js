/* Flux : mode hors ligne. Met en cache la page du lecteur et hls.js ; ne touche pas à /api. */
const V = 'flux-v2';
const HLS = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
const STATIC = ['/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all([
      c.add('/').catch(() => {}),
      fetch(HLS, { mode: 'no-cors' }).then(r => c.put(HLS, r)).catch(() => {}),
      ...STATIC.map(u => c.add(u).catch(() => {})),
    ]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function nav(req) {
  const c = await caches.open(V);
  try {
    const net = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(no, 4000))]);
    if (net && net.ok) c.put('/', net.clone());
    return net;
  } catch (e) {
    const m = await c.match('/');
    return m || new Response('Hors ligne : ouvre l\u2019appli une première fois avec du réseau.', { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  }
}

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/')) return;
    if (r.mode === 'navigate' && (u.pathname === '/' || u.pathname === '/index.html')) return e.respondWith(nav(r));
    if (STATIC.includes(u.pathname)) e.respondWith(caches.match(r).then(m => m || fetch(r)));
    return;
  }
  if (u.href === HLS) e.respondWith(caches.match(HLS).then(m => m || fetch(r)));
});
