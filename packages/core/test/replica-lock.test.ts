import { describe, expect, it } from "vitest";
import { createDeferredPromise } from "../src/utils";
import { acquireReplicaLock, runWithNoActiveReplicas } from "../src/worker-db/replica-lock";

describe.runIf(globalThis.navigator?.locks)("replica locks", () => {
  it("skips cleanup until every existing replica has released its lock", async () => {
    const dbId = crypto.randomUUID();
    const releaseFirst = await acquireReplicaLock({ dbId });
    const releaseSecond = await acquireReplicaLock({ dbId });
    let runs = 0;
    const cleanup = () =>
      runWithNoActiveReplicas({
        dbId,
        run: () => {
          runs++;
        },
      });

    try {
      expect(await cleanup()).toBe(false);
      await releaseFirst();
      expect(await cleanup()).toBe(false);
      await releaseSecond();
      expect(await cleanup()).toBe(true);
      expect(runs).toBe(1);
    } finally {
      await releaseFirst();
      await releaseSecond();
    }
  });

  it("does not let a new replica read its snapshot while cleanup holds the lock", async () => {
    const dbId = crypto.randomUUID();
    const started = createDeferredPromise<void>();
    const finished = createDeferredPromise<void>();
    const cleanup = runWithNoActiveReplicas({
      dbId,
      run: () => {
        started.resolve();
        return finished.promise;
      },
    });
    await started.promise;
    let acquired = false;
    const replica = acquireReplicaLock({ dbId }).then((release) => {
      acquired = true;
      return release;
    });

    try {
      const locks = await navigator.locks.query();
      expect(locks.pending?.some((lock) => lock.name === `sync-db-replica-lock-${dbId}`)).toBe(true);
      expect(acquired).toBe(false);
    } finally {
      finished.resolve();
      await cleanup;
      const release = await replica;
      await release();
    }
    expect(acquired).toBe(true);
  });

  it("allows cleanup for a different database", async () => {
    const release = await acquireReplicaLock({ dbId: crypto.randomUUID() });
    try {
      expect(await runWithNoActiveReplicas({ dbId: crypto.randomUUID(), run: () => {} })).toBe(true);
    } finally {
      await release();
    }
  });

  it("releases the cleanup lock when cleanup fails", async () => {
    const dbId = crypto.randomUUID();
    await expect(
      runWithNoActiveReplicas({
        dbId,
        run: () => {
          throw new Error("cleanup failed");
        },
      }),
    ).rejects.toThrow("cleanup failed");
    const release = await acquireReplicaLock({ dbId });
    await release();
    expect(await runWithNoActiveReplicas({ dbId, run: () => {} })).toBe(true);
  });
});
