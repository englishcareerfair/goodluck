// Career Fair 2026 - Service Worker
const CACHE_NAME = 'cf-cache-v28.5-fast';

// Lean app-shell pre-cache (audio MP3s stream/cache on demand so install is fast)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=28.2',
  '/loader.js?v=28.2',
  '/offline-stt.js?v=28.2',
  '/app.js?v=28.2',
  '/dopamine-engine.js?v=28.2',
  '/game-completion-detector.js?v=28.2',
  '/dossier-pdf.js?v=28.2',
  '/guide-avatar.js?v=28.2',
  '/qrcode.min.js',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/favicon.svg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

const PRESERVED_CACHES = new Set([CACHE_NAME, 'transformers-cache', 'cf-whisper-cdn-v1']);

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => !PRESERVED_CACHES.has(key)).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  const isSameOrigin = (url.origin === location.origin);

  // Cache-first persistence for @huggingface/transformers & ONNX WASM offline Whisper runtime
  if (!isSameOrigin && url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('@huggingface/transformers')) {
    event.respondWith(
      caches.open('cf-whisper-cdn-v1').then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const netRes = await fetch(event.request);
        if (netRes && netRes.ok) {
          cache.put(event.request, netRes.clone()).catch(() => {});
        }
        return netRes;
      })
    );
    return;
  }

  // Let browser handle other cross-origin CDN scripts, fonts, dictionaries, and embeds directly (preserves SRI/CORS)
  if (!isSameOrigin) {
    return;
  }

  // NEVER cache API requests, admin endpoints, or external AI/TTS streaming
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) {
    return;
  }
  const isNavigation = (event.request.mode === 'navigate');
  const isHtmlAccept = (event.request.headers.get('accept') || '').includes('text/html');
  const isDocumentDest = (event.request.destination === 'document');

  // SPA deep-linking routes: same-origin paths without a file extension (e.g. /games, /careers, /roadmap, /games/wordle)
  const lastSegment = url.pathname.split('/').pop() || '';
  const isExtensionlessPath = isSameOrigin && !lastSegment.includes('.');
  const isHtmlOrJsAsset = url.pathname.endsWith('.html') || url.pathname.endsWith('.js');

  const isSpaOrPageRequest = isNavigation || isDocumentDest || isHtmlAccept || isExtensionlessPath || isHtmlOrJsAsset;

  // 1. Network-first strategy for HTML documents, JS bundles, and SPA page routes
  if (isSpaOrPageRequest) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = event.request.mode === 'navigate'
            ? await fetch(event.request)
            : await fetch(event.request, { cache: 'no-cache' });

          // Immediate ban / restricted client response: purge all caches and unregister service worker immediately!
          if (networkResponse && networkResponse.status === 403) {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
              await self.registration.unregister();
            } catch (_) {}
            return new Response(null, {
              status: 403,
              statusText: 'Forbidden',
              headers: { 'Connection': 'close', 'Cache-Control': 'no-store' }
            });
          }

          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
            return networkResponse;
          }
          // If server returned 404 for an extensionless SPA path (e.g. /games), fallback to cached SPA shell
          if (networkResponse && networkResponse.status === 404 && isExtensionlessPath) {
            const cachedShell = (await caches.match('/index.html')) || (await caches.match('/'));
            if (cachedShell) return cachedShell;
          }
          if (networkResponse) {
            return networkResponse;
          }
        } catch (err) {
          // Network failed (offline, timeout, or network blip)
        }

        // Cache fallback: exact match -> /index.html -> /
        const cached = (await caches.match(event.request)) ||
                       (await caches.match('/index.html')) ||
                       (await caches.match('/'));
        if (cached) {
          return cached;
        }

        // Guaranteed valid Response object fallback (NEVER undefined and NEVER auto-reloads)
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Career Fair 2026 - Offline</title><style>body{background:#0a0e17;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}h2{margin-bottom:8px;}p{color:#94a3b8;font-size:14px;}</style></head><body><div><h2>Career Fair 2026</h2><p>Offline or network connection interrupted. Please check your connection.</p></div></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })()
    );
    return;
  }

  // 2. Stale-while-revalidate for images, icons, and static assets
  event.respondWith(
    (async () => {
      const cachedResponse = await caches.match(event.request);

      const fetchPromise = fetch(event.request)
        .then(async (networkResponse) => {
          if (networkResponse && networkResponse.status === 403) {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
              await self.registration.unregister();
            } catch (_) {}
            return networkResponse;
          }
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => null);

      if (cachedResponse) {
        // Return cached asset immediately, revalidate in background
        fetchPromise.catch(() => {});
        return cachedResponse;
      }

      // Not in cache: await network response
      const networkResult = await fetchPromise;
      if (networkResult) {
        return networkResult;
      }

      // If both cache and network fail, return a valid 404 Response (NEVER undefined)
      return new Response('', { status: 404, statusText: 'Not Found' });
    })()
  );
});
