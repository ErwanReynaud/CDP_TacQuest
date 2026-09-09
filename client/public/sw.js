/* Service worker TacticalQuest — app shell + cache hors-ligne des tuiles.
 *
 * Trois règles :
 *  - /socket.io/*  : jamais intercepté.
 *  - tuiles        : cache-first sans revalidation (quasi immuables ; la
 *                    revalidation gaspillerait la bande passante qu'on veut
 *                    économiser en zone blanche), éviction FIFO plafonnée.
 *  - app shell     : network-first pour les navigations, cache-first pour
 *                    les assets hashés (auto-invalidants).
 */

const SHELL_CACHE = 'tq-shell-v1';
const TILE_CACHE = 'tq-tiles-v1';

// Garder synchronisé avec client/src/map/layers.ts
const TILE_HOSTS = [
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'data.geopf.fr',
];

const TILE_CACHE_MAX = 2000;
const EVICT_BATCH = 200;
const EVICT_CHECK_EVERY = 50;
const QUOTA_MAX_RATIO = 0.8;

let insertsSinceCheck = 0;

// PNG transparent 1×1 : évite que Leaflet affiche des tuiles cassées hors-ligne.
const TRANSPARENT_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(['/'])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, TILE_CACHE];
      for (const name of await caches.keys()) {
        if (!keep.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/socket.io/')) return;
  // Console d'admin : toujours servie en direct, jamais cachée (hors PWA).
  if (url.pathname.startsWith('/admin')) return;

  // data.geopf.fr sert aussi le géocodage : seules les tuiles (/wmts, dont
  // /private/wmts pour le SCAN 25) passent par le cache-first — cacher une
  // recherche la figerait pour toujours.
  const isTile =
    TILE_HOSTS.includes(url.hostname) &&
    (url.hostname !== 'data.geopf.fr' ||
      url.pathname.startsWith('/wmts') ||
      url.pathname.startsWith('/private/wmts'));
  if (isTile) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (event.request.mode === 'navigate') {
      event.respondWith(networkFirstShell(event.request));
    } else if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(SHELL_CACHE, event.request));
    } else {
      event.respondWith(networkFirstShell(event.request));
    }
  }
});

async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) {
      await maybeCacheTile(cache, request, res.clone());
    }
    return res;
  } catch {
    return new Response(TRANSPARENT_PNG, {
      headers: { 'Content-Type': 'image/png' },
    });
  }
}

async function maybeCacheTile(cache, request, response) {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (quota && usage / quota > QUOTA_MAX_RATIO) return;
    }
    await cache.put(request, response);
    insertsSinceCheck += 1;
    if (insertsSinceCheck >= EVICT_CHECK_EVERY) {
      insertsSinceCheck = 0;
      await evictTiles(cache);
    }
  } catch {
    /* quota plein : on continue sans cacher */
  }
}

// FIFO : keys() préserve l'ordre d'insertion en pratique — suffisant ici,
// et évite une couche de comptabilité IndexedDB.
async function evictTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_CACHE_MAX) return;
  const toDelete = keys.slice(0, Math.min(EVICT_BATCH, keys.length - TILE_CACHE_MAX + EVICT_BATCH));
  await Promise.all(toDelete.map((k) => cache.delete(k)));
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) {
      const key = request.mode === 'navigate' ? '/' : request;
      await cache.put(key, res.clone());
    }
    return res;
  } catch {
    const hit = await cache.match(request.mode === 'navigate' ? '/' : request);
    if (hit) return hit;
    throw new Error('offline et non caché');
  }
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}
