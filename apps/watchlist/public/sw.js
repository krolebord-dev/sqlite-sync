// No-op service worker to replace any previously cached service worker.
// It clears all caches and unregisters itself on activation.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", async () => {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map((name) => caches.delete(name)));
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.navigate(client.url);
  }
  self.registration.unregister();
});
