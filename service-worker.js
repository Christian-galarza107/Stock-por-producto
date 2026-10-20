/* ══════════════════════════════════════════════════════════════════════
   Stock en Planta — Service Worker
   ----------------------------------------------------------------------
   PARA PUBLICAR UNA VERSIÓN NUEVA: cambiar SÓLO la constante APP_VER.
   Eso invalida el caché viejo y dispara el aviso "Hay una nueva versión".
   ══════════════════════════════════════════════════════════════════════ */
const APP_VER = '3.32.0';
const CACHE   = 'stock-en-planta-v' + APP_VER;

/* Fotos de productos (v3.31.0) — caché PROPIO, separado del de arranque.
   · No depende de APP_VER: actualizar la app no borra las fotos ya vistas.
   · Nunca se precachea: sólo se guarda lo que el usuario efectivamente miró.
   · Tope por tamaño de variante; al pasarlo se descartan las menos recientes.
   · Los nombres de archivo llevan el hash del contenido: una foto
     reemplazada tiene otro nombre, así que caché-primero nunca muestra
     una foto vieja (el catálogo apunta al nombre nuevo). */
const FOTOS_CACHE = 'pq-fotos-v1';
const FOTOS_TOPE  = { m: 1500, d: 150 };     /* miniaturas ~5-10 KB · detalle ~40-80 KB */
const RX_FOTO     = /\/data\/imagenes\/([a-z])\/[^/]+\.webp$/;
const RX_CAT_FOTO = /\/data\/imagenes-productos\.json$/;

/* Desde la v3.0.0 la interfaz usa Tailwind y FontAwesome por CDN.
   Se precachean acá para que, después de la primera carga, sigan
   andando sin conexión igual que el resto de la app. */
/* v3.32.0: la app ya no usa ningún CDN (Tailwind y FontAwesome se reemplazaron por CSS y SVG propios). */
const EXTERNAL_ORIGINS = [];

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
    await Promise.all(keys.filter(k => k !== CACHE && k !== FOTOS_CACHE).map(k => caches.delete(k)));
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

  /* Fotos (v3.31.0): caché primero; sin red y sin copia → 504 y la app
     muestra el recuadro neutro. Una foto jamás bloquea ni rompe nada. */
  const mFoto = url.origin === self.location.origin && url.pathname.match(RX_FOTO);
  if (mFoto) {
    e.respondWith((async () => {
      let c = null;
      try { c = await caches.open(FOTOS_CACHE); } catch (err) {}
      const hit = c && await c.match(req, { ignoreSearch: true });
      if (hit) { e.waitUntil(tocarFoto(c, req, hit.clone())); return hit; }
      try {
        const net = await fetch(req);
        if (net && net.ok && c) e.waitUntil(guardarFoto(c, req, net.clone(), mFoto[1]));
        return net;
      } catch (err) { return new Response('', { status: 504, statusText: 'sin conexion' }); }
    })());
    return;
  }
  /* Catálogo de fotos: red primero (con revalidación), copia como respaldo */
  if (url.origin === self.location.origin && RX_CAT_FOTO.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        if (net && net.ok) { try { const c = await caches.open(FOTOS_CACHE); await c.put(url.pathname, net.clone()); } catch (err) {} }
        return net;
      } catch (err) {
        try { const c = await caches.open(FOTOS_CACHE); const hit = await c.match(url.pathname); if (hit) return hit; } catch (e2) {}
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* GitHub Data Hub (v3.15.0): todo lo que cuelga de /data/ SIEMPRE se busca
     en la red primero. Si se sirviera desde caché, el celular seguiría viendo
     los datos de la semana pasada aunque ya se hubiera publicado un paquete
     nuevo — y peor: version.json diría que no hay nada nuevo. La copia
     cacheada queda sólo como respaldo para cuando no hay señal. */
  if (/\/data\/(database\.json(\.gz)?|version\.json)$/.test(url.pathname)) {
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

/* ── caché de fotos: tope y «más recientes primero» ─────────────────── */
async function guardarFoto(c, req, res, variante) {
  try {
    await c.put(req, res);
    await recortarFotos(c, variante);
  } catch (err) {
    /* almacenamiento lleno (QuotaExceededError): se libera la mitad de las
       miniaturas/detalles más viejos y se sigue sin guardar esta foto */
    try { await recortarFotos(c, variante, true); } catch (e2) {}
  }
}
async function tocarFoto(c, req, res) {
  /* re-guardar mueve la entrada al final del orden: la más usada sobrevive al recorte */
  try { await c.delete(req, { ignoreSearch: true }); await c.put(req, res); } catch (err) {}
}
async function recortarFotos(c, variante, agresivo) {
  const tope = FOTOS_TOPE[variante] || 200;
  const keys = (await c.keys()).filter(k => {
    const m = new URL(k.url).pathname.match(RX_FOTO); return m && m[1] === variante; });
  const sobra = agresivo ? Math.ceil(keys.length / 2) : keys.length - tope;
  for (let i = 0; i < sobra; i++) await c.delete(keys[i]);
}
