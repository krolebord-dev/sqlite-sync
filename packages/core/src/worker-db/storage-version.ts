import type { ResetStore } from "./reset-state";

/**
 * Internal persisted-storage format version. Bump when the library changes
 * the worker DB layout in a way old persisted databases cannot survive —
 * every client resets its local DB on the next worker start.
 */
export const LIB_STORAGE_VERSION = 1;

const storageVersionKey = (dbId: string) => `sqlite-sync-storage-version-${dbId}`;

export function formatStorageVersion(appStorageVersion: string | undefined): string {
  return appStorageVersion === undefined
    ? `lib-v${LIB_STORAGE_VERSION}`
    : `lib-v${LIB_STORAGE_VERSION}:app-${appStorageVersion}`;
}

type StorageVersionStoreOptions = {
  store: ResetStore;
  dbId: string;
  /** Dev-provided app storage version, combined with the internal lib version. */
  appStorageVersion?: string;
};

export type StorageVersionStore = ReturnType<typeof createStorageVersionStore>;

/**
 * Worker-owned durable storage version. The current version combines the
 * internal lib version with the dev-provided app version; when the stored
 * version does not match (including a missing record), the elected worker
 * initializes with `clearOnInit: true`. Wiping on a missing record is
 * harmless for fresh installs and correctly resets databases persisted
 * before versioning existed.
 */
export function createStorageVersionStore({ store, dbId, appStorageVersion }: StorageVersionStoreOptions) {
  const key = storageVersionKey(dbId);
  const currentVersion = formatStorageVersion(appStorageVersion);

  return {
    currentVersion,
    async isVersionMismatch(): Promise<boolean> {
      const storedVersion = await store.get<string>(key);
      return storedVersion !== currentVersion;
    },
    /**
     * Record the current version. Must be called only after the worker has
     * successfully initialized with the wiped DB, so a failed init can be
     * retried by a later elected worker.
     */
    async markCurrentVersionApplied(): Promise<void> {
      await store.set(key, currentVersion);
    },
  };
}
