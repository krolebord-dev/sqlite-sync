// No-op service worker to replace any previously cached service worker.
// It clears all caches and unregisters itself on activation.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));

      await self.registration.unregister();

      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        if (client.url && "navigate" in client) {
          client.navigate(client.url);
        }
      }
    })()
  );
});
