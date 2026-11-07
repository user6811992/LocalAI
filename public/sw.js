// Local AI service worker — app-shell cache + network-first for API
const CACHE = 'local-ai-v9';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

// Self-destruct: unregister this SW and clear all caches so users always get fresh content
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // Delete all caches
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Unregister this service worker
      await self.registration.unregister();
      // Notify all clients to reload
      const clients = await self.clients.matchAll();
      for (const client of clients) {
        client.postMessage({ type: 'sw-unregistered' });
      }
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API/Ollama calls: network only
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // App shell HTML: network-only (never cache, so updates always load)
  const isNav = e.request.mode === 'navigate' || e.request.destination === 'document';
  if (isNav) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // All other assets: network-first, then cache (ensures updates load)
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
