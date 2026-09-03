/* ══════════════════════════════════════════════════════════════════════
   Stock en Planta — Service Worker
   ----------------------------------------------------------------------
   PARA PUBLICAR UNA VERSIÓN NUEVA: cambiar SÓLO la constante APP_VER.
   Eso invalida el caché viejo y dispara el aviso "Hay una nueva versión".
   ══════════════════════════════════════════════════════════════════════ */
const APP_VER = '3.11.1';
const CACHE   = 'stock-en-planta-v' + APP_VER;

/* Desde la v3.0.0 la interfaz usa Tailwind y FontAwesome por CDN.
   Se precachean acá para que, después de la primera carga, sigan
   andando sin conexión igual que el resto de la app. */
const EXTERNAL_ORIGINS = ['https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'];

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
  './favicon-32.png',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css'
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
  const esExterno = url.origin !== self.location.origin;
  /* nada externo salvo los dos CDN de Tailwind/FontAwesome que la interfaz necesita */
  if (esExterno && !EXTERNAL_ORIGINS.includes(url.origin)) return;

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

  /* El snapshot de datos SIEMPRE se busca en la red primero: si se sirviera
     desde caché, el celular seguiría mostrando los datos de la semana pasada
     aunque ya se hubiera publicado uno nuevo. La copia cacheada queda sólo
     como respaldo para cuando no hay señal. */
  if (url.pathname.endsWith('/datos.json.gz') || url.pathname.endsWith('datos.json.gz')) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        if (net && net.ok) { const c = await caches.open(CACHE); c.put(req, net.clone()); }
        return net;
      } catch (err) {
        return (await caches.match(req)) || new Response('', { status: 504 });
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
