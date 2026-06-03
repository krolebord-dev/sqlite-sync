import { describe, expect, it } from "vitest";
import type { ResetStore } from "../src/worker-db/reset-state";
import { createStorageVersionStore, formatStorageVersion, LIB_STORAGE_VERSION } from "../src/worker-db/storage-version";

function createMemoryStore(): ResetStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

const DB_ID = "test-db";
const versionKey = `sqlite-sync-storage-version-${DB_ID}`;

describe("formatStorageVersion", () => {
  it("combines the lib version with the app version", () => {
    expect(formatStorageVersion("3")).toBe(`lib-v${LIB_STORAGE_VERSION}:app-3`);
  });

  it("uses only the lib version when no app version is provided", () => {
    expect(formatStorageVersion(undefined)).toBe(`lib-v${LIB_STORAGE_VERSION}`);
  });
});

describe("storage version store", () => {
  it("reports a mismatch when no version is stored (first run or pre-versioned DB)", async () => {
    const store = createMemoryStore();
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "1" });

    await expect(storageVersion.isVersionMismatch()).resolves.toBe(true);
  });

  it("reports no mismatch when the stored version matches", async () => {
    const store = createMemoryStore();
    store.map.set(versionKey, formatStorageVersion("1"));
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "1" });

    await expect(storageVersion.isVersionMismatch()).resolves.toBe(false);
  });

  it("reports a mismatch when the app version changes", async () => {
    const store = createMemoryStore();
    store.map.set(versionKey, formatStorageVersion("1"));
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });

    await expect(storageVersion.isVersionMismatch()).resolves.toBe(true);
  });

  it("reports a mismatch when the lib version changes", async () => {
    const store = createMemoryStore();
    store.map.set(versionKey, `lib-v${LIB_STORAGE_VERSION - 1}:app-1`);
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "1" });

    await expect(storageVersion.isVersionMismatch()).resolves.toBe(true);
  });

  it("stores the combined current version on markCurrentVersionApplied", async () => {
    const store = createMemoryStore();
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });

    await storageVersion.markCurrentVersionApplied();

    expect(store.map.get(versionKey)).toBe(formatStorageVersion("2"));
    await expect(storageVersion.isVersionMismatch()).resolves.toBe(false);
  });

  it("lets a later elected worker retry the reset if init failed before recording the version", async () => {
    const store = createMemoryStore();
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });
    await expect(storageVersion.isVersionMismatch()).resolves.toBe(true);
    // Init fails — markCurrentVersionApplied is never called.

    const retryStorageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });
    await expect(retryStorageVersion.isVersionMismatch()).resolves.toBe(true);
  });

  it("does not wipe again after a later election with the same version", async () => {
    const store = createMemoryStore();
    const storageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });
    await storageVersion.markCurrentVersionApplied();

    const laterStorageVersion = createStorageVersionStore({ store, dbId: DB_ID, appStorageVersion: "2" });
    await expect(laterStorageVersion.isVersionMismatch()).resolves.toBe(false);
  });

  it("scopes versions by dbId", async () => {
    const store = createMemoryStore();
    const dbA = createStorageVersionStore({ store, dbId: "db-a", appStorageVersion: "1" });
    await dbA.markCurrentVersionApplied();

    const dbB = createStorageVersionStore({ store, dbId: "db-b", appStorageVersion: "1" });
    await expect(dbB.isVersionMismatch()).resolves.toBe(true);
    await expect(dbA.isVersionMismatch()).resolves.toBe(false);
  });
});
