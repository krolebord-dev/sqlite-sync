import { acquireLock } from "../utils";

const replicaLockName = (dbId: string) => `sync-db-replica-lock-${dbId}`;

export function acquireReplicaLock({ dbId }: { dbId: string }) {
  return acquireLock(replicaLockName(dbId), { mode: "shared" });
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
