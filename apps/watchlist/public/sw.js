// No-op service worker to replace any previously cached service worker.
// It clears all caches and unregisters itself on activation.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();

      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));

      await self.registration.unregister();
    })(),
  );
});
