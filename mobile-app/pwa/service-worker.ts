/// <reference lib="webworker" />

/**
 * Pixel Agents Service Worker
 *
 * Caches static assets (JS, CSS, fonts, sprites) for offline layout editing.
 * Dynamic API requests (/assets/decoded/, /ws) are never cached.
 * On reconnect, the app fetches fresh state from the server.
 */

declare const self: ServiceWorkerGlobalScope;

const CACHE_VERSION = 'pixel-agents-v1';

// URL patterns to cache on install (shell assets)
const PRECACHE_PATTERNS = [
  '/',
  '/index.html',
  '/pwa-manifest.json',
  '/icon.png',
];

// URL patterns that should NEVER be cached (dynamic server data)
const NEVER_CACHE_PATTERNS = [
  '/assets/decoded/',
  '/ws',
  '/pair',
  '/health',
];

function shouldNeverCache(url: string): boolean {
  return NEVER_CACHE_PATTERNS.some((p) => url.includes(p));
}

// Install: precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(PRECACHE_PATTERNS).catch((err) => {
        // Non-fatal: precache may fail if server is offline during install
        console.warn('[SW] Precache failed (non-fatal):', err);
      });
    }),
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// Activate: delete old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: cache-first for static assets, network-first for everything else
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Never cache dynamic API / WebSocket endpoints
  if (shouldNeverCache(url.pathname)) return;

  // Cache-first strategy: static assets (JS, CSS, fonts, PNGs served as static)
  const isStaticAsset =
    url.pathname.startsWith('/assets/characters') ||
    url.pathname.startsWith('/assets/floors') ||
    url.pathname.startsWith('/assets/walls') ||
    url.pathname.startsWith('/assets/furniture-catalog') ||
    url.pathname.startsWith('/assets/asset-index') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.match(/\.(js|css|woff2?|ttf|png|json)$/) !== null;

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only cache successful responses
          if (response.ok) {
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Network-first for navigation / HTML (app shell)
  if (request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match('/') ?? caches.match('/index.html') ?? Response.error()),
    );
  }
});
