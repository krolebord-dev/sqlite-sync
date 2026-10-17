import { describe, expect, it, vi } from "vitest";
import { enqueueIndexing, processIndexingBatch } from "./indexing-queue";

function createStorage() {
  const kv = new Map<string, unknown>();
  const storage = {
    kv: {
      get: (key: string) => kv.get(key),
      put: (key: string, value: unknown) => kv.set(key, value),
      delete: (key: string) => kv.delete(key),
    },
    setAlarm: vi.fn(async () => {}),
  };
  return storage as unknown as DurableObjectStorage & { setAlarm: typeof storage.setAlarm };
}

const itemIds = (count: number) => Array.from({ length: count }, (_, i) => `item-${i}`);

describe("indexing queue", () => {
  it("processes items in batches and reschedules until the queue is empty", async () => {
    const storage = createStorage();
    const indexItem = vi.fn(async () => {});

    await enqueueIndexing(storage, itemIds(25));
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);

    await processIndexingBatch(storage, indexItem);
    expect(indexItem).toHaveBeenCalledTimes(20);
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);

    await processIndexingBatch(storage, indexItem);
    expect(indexItem).toHaveBeenCalledTimes(25);
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
    expect(storage.kv.get("indexing:queue")).toBeUndefined();
  });

  it("keeps going when an item fails and dedupes re-enqueued items", async () => {
    const storage = createStorage();
    const indexItem = vi.fn(async (itemId: string) => {
      if (itemId === "item-1") throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await enqueueIndexing(storage, itemIds(3));
    await enqueueIndexing(storage, itemIds(3));
    await processIndexingBatch(storage, indexItem);

    expect(indexItem.mock.calls.map(([itemId]) => itemId)).toEqual(["item-0", "item-1", "item-2"]);
    expect(storage.kv.get("indexing:queue")).toBeUndefined();
  });

  it("keeps items enqueued while a batch is running", async () => {
    const storage = createStorage();
    await enqueueIndexing(storage, ["item-0"]);

    await processIndexingBatch(storage, async () => {
      await enqueueIndexing(storage, ["item-1"]);
    });

    expect(storage.kv.get("indexing:queue")).toEqual(["item-1"]);
  });
});
