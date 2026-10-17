const QUEUE_KEY = "indexing:queue";
const BATCH_SIZE = 20;
const CONCURRENCY = 4;

export async function enqueueIndexing(storage: DurableObjectStorage, itemIds: string[]) {
  const queue = new Set([...(storage.kv.get<string[]>(QUEUE_KEY) ?? []), ...itemIds]);
  storage.kv.put(QUEUE_KEY, [...queue]);
  await storage.setAlarm(Date.now());
}

export async function processIndexingBatch(
  storage: DurableObjectStorage,
  indexItem: (itemId: string) => Promise<unknown>,
) {
  const batch = (storage.kv.get<string[]>(QUEUE_KEY) ?? []).slice(0, BATCH_SIZE);
  const pending = [...batch];

  const worker = async () => {
    for (let itemId = pending.shift(); itemId; itemId = pending.shift()) {
      await indexItem(itemId).catch((error) => console.error(`Failed to index item ${itemId}`, error));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const processed = new Set(batch);
  const remaining = (storage.kv.get<string[]>(QUEUE_KEY) ?? []).filter((itemId) => !processed.has(itemId));
  if (remaining.length === 0) {
    storage.kv.delete(QUEUE_KEY);
    return;
  }

  storage.kv.put(QUEUE_KEY, remaining);
  await storage.setAlarm(Date.now());
}
