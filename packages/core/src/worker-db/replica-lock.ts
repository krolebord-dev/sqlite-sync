import { createDeferredPromise } from "../utils";

const replicaLockName = (dbId: string) => `sync-db-replica-lock-${dbId}`;

export async function acquireReplicaLock({ dbId }: { dbId: string }) {
  const acquired = createDeferredPromise<void>();
  const released = createDeferredPromise<void>();
  const request = navigator.locks.request(replicaLockName(dbId), { mode: "shared" }, () => {
    acquired.resolve();
    return released.promise;
  });
  void request.catch((error: unknown) => acquired.reject(error instanceof Error ? error : new Error(String(error))));
  await acquired.promise;

  return async () => {
    released.resolve();
    await request;
  };
}

export function runWithNoActiveReplicas({ dbId, run }: { dbId: string; run: () => void | Promise<void> }) {
  return navigator.locks.request(replicaLockName(dbId), { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) {
      return false;
    }
    await run();
    return true;
  });
}
