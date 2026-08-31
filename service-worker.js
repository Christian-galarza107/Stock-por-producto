/* ══════════════════════════════════════════════════════════════════════
   Stock en Planta — Service Worker
   ----------------------------------------------------------------------
   PARA PUBLICAR UNA VERSIÓN NUEVA: cambiar SÓLO la constante APP_VER.
   Eso invalida el caché viejo y dispara el aviso "Hay una nueva versión".
   ══════════════════════════════════════════════════════════════════════ */
const APP_VER = '2.4.0';
const CACHE   = 'stock-en-planta-v' + APP_VER;

/* Todo lo que la app necesita para arrancar sin conexión.
   El HTML pesa ~1 MB porque lleva SheetJS embebido: se cachea igual. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './maskable-192.png',
  './maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener('install', e => {
  /* se precachea todo, pero un recurso opcional que falle no debe romper la instalación */
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(u => c.add(u).catch(() => null)));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

/* La página pide saltar la espera cuando el usuario toca "Actualizar ahora" */
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'GET_VERSION' && e.source) e.source.postMessage({ ver: APP_VER });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   /* nada externo: la app es 100% local */

  /* Navegación (abrir la app): red primero para detectar versión nueva,
     caché si no hay señal. Es lo que la hace usable en el depósito sin datos. */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const pre = await e.preloadResponse;
        const net = pre || await fetch(req);
        const c = await caches.open(CACHE); c.put('./index.html', net.clone());
        return net;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./')) ||
          new Response('<h1>Sin conexión</h1><p>Abrí la app una vez con internet para dejarla instalada.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  /* Resto (iconos, manifest): caché primero, y se refresca en segundo plano */
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) { fetch(req).then(r => { if (r && r.ok) caches.open(CACHE).then(c => c.put(req, r)); }).catch(() => {}); return hit; }
    try { const net = await fetch(req);
      if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()); }
      return net;
    } catch (err) { return new Response('', { status: 504 }); }
  })());
});
