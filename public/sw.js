// Career Fair 2026 - Service Worker
const CACHE_NAME = 'cf-cache-v26.5-fast';

// Lean app-shell pre-cache (audio MP3s stream/cache on demand so install is fast)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css?v=26.5',
  '/loader.js?v=26.5',
  '/app.js?v=26.5',
  '/voicelab.js?v=26.5',
  '/dopamine-engine.js?v=26.5',
  '/game-completion-detector.js?v=26.5',
  '/dossier-pdf.js?v=26.5',
  '/guide-avatar.js?v=26.5',
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
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

  // Let browser handle cross-origin CDN scripts, fonts, dictionaries, and embeds directly (preserves SRI/CORS)
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

        // Guaranteed valid Response object fallback (NEVER undefined)
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Career Fair 2026</title></head><body><script>location.reload();</script></body></html>',
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
        .then((networkResponse) => {
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
