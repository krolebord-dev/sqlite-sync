import { describe, expect, it } from "vitest";
import {
  createReloadRequestHandler,
  createResetStateStore,
  RESET_REQUEST_TTL_MS,
  type ResetRequest,
  type ResetStore,
} from "../src/worker-db/reset-state";
import type { WorkerNotificationMessage } from "../src/worker-db/worker-common";

type ReloadNotification = Extract<WorkerNotificationMessage, { notificationType: "reload-requested" }>;

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
const requestKey = `sqlite-sync-reset-request-${DB_ID}`;
const appliedKey = `sqlite-sync-reset-applied-${DB_ID}`;

function createHarness({
  now = () => 1_000_000,
  store = createMemoryStore(),
}: {
  now?: () => number;
  store?: ReturnType<typeof createMemoryStore>;
} = {}) {
  const resetState = createResetStateStore({ store, dbId: DB_ID, now });
  const broadcasts: ReloadNotification[] = [];
  const writesBeforeBroadcast: boolean[] = [];
  const requestReload = createReloadRequestHandler({
    resetState,
    broadcast: (message) => {
      broadcasts.push(message);
      writesBeforeBroadcast.push(store.map.has(requestKey));
    },
    generateEpoch: () => `epoch-${broadcasts.length + 1}`,
  });
  return { store, resetState, broadcasts, writesBeforeBroadcast, requestReload };
}

describe("requestReload handler", () => {
  it("broadcasts reload-requested with the expected clean value", async () => {
    const { requestReload, broadcasts } = createHarness();

    await requestReload({ clean: false });
    await requestReload({ clean: true });

    expect(broadcasts).toEqual([
      { notificationType: "reload-requested", reloadEpoch: "epoch-1", clean: false },
      { notificationType: "reload-requested", reloadEpoch: "epoch-2", clean: true },
    ]);
  });

  it("clean: true writes a reset request epoch before broadcasting reload", async () => {
    const now = () => 42_000;
    const { requestReload, store, writesBeforeBroadcast, broadcasts } = createHarness({ now });

    await requestReload({ clean: true });

    expect(writesBeforeBroadcast).toEqual([true]);
    expect(store.map.get(requestKey)).toEqual({
      epoch: broadcasts[0].reloadEpoch,
      requestedAt: 42_000,
    } satisfies ResetRequest);
  });

  it("clean: false does not write a clean reset request", async () => {
    const { requestReload, store } = createHarness();

    await requestReload({ clean: false });

    expect(store.map.has(requestKey)).toBe(false);
  });
});

describe("startup reset resolution", () => {
  it("applies the reset when the request epoch differs from the applied epoch and is within the TTL", async () => {
    const store = createMemoryStore();
    const requestedAt = 1_000_000;
    store.map.set(requestKey, { epoch: "epoch-1", requestedAt } satisfies ResetRequest);
    store.map.set(appliedKey, "older-epoch");

    const resetState = createResetStateStore({
      store,
      dbId: DB_ID,
      now: () => requestedAt + RESET_REQUEST_TTL_MS,
    });

    await expect(resetState.resolvePendingReset()).resolves.toEqual({ epoch: "epoch-1", requestedAt });
  });

  it("ignores and deletes a reset request older than the TTL", async () => {
    const store = createMemoryStore();
    const requestedAt = 1_000_000;
    store.map.set(requestKey, { epoch: "epoch-1", requestedAt } satisfies ResetRequest);

    const resetState = createResetStateStore({
      store,
      dbId: DB_ID,
      now: () => requestedAt + RESET_REQUEST_TTL_MS + 1,
    });

    await expect(resetState.resolvePendingReset()).resolves.toBeUndefined();
    expect(store.map.has(requestKey)).toBe(false);
  });

  it("returns undefined when there is no reset request", async () => {
    const { resetState } = createHarness();

    await expect(resetState.resolvePendingReset()).resolves.toBeUndefined();
  });

  it("records the applied epoch after successful clean initialization", async () => {
    const { requestReload, resetState, store } = createHarness();
    await requestReload({ clean: true });

    const pending = await resetState.resolvePendingReset();
    if (!pending) throw new Error("Expected a pending reset");

    // Simulates successful worker init with clearOnInit: true.
    await resetState.markResetApplied(pending.epoch);

    expect(store.map.get(appliedKey)).toBe(pending.epoch);
  });

  it("does not wipe again when a later worker election sees the same applied epoch", async () => {
    const { requestReload, resetState, store } = createHarness();
    await requestReload({ clean: true });

    const pending = await resetState.resolvePendingReset();
    if (!pending) throw new Error("Expected a pending reset");
    await resetState.markResetApplied(pending.epoch);

    // A later worker election over the same durable storage.
    const laterResetState = createResetStateStore({ store, dbId: DB_ID, now: () => 1_000_000 });
    await expect(laterResetState.resolvePendingReset()).resolves.toBeUndefined();
  });

  it("lets a later elected worker retry the reset if init failed before recording the applied epoch", async () => {
    const { requestReload, resetState, store } = createHarness();
    await requestReload({ clean: true });

    const pending = await resetState.resolvePendingReset();
    expect(pending).toBeDefined();
    // Init fails — markResetApplied is never called.

    const retryResetState = createResetStateStore({ store, dbId: DB_ID, now: () => 1_000_000 });
    await expect(retryResetState.resolvePendingReset()).resolves.toEqual(pending);
  });

  it("applies the reset even when a different tab's worker wins the post-reload election", async () => {
    const store = createMemoryStore();
    // Tab A's worker handles requestReload({ clean: true }).
    const { requestReload } = createHarness({ store });
    await requestReload({ clean: true });

    // After the reload broadcast, tab B's worker wins the election instead.
    const tabBResetState = createResetStateStore({ store, dbId: DB_ID, now: () => 1_000_000 });
    const pending = await tabBResetState.resolvePendingReset();
    if (!pending) throw new Error("Expected a pending reset");
    expect(pending.epoch).toBe("epoch-1");

    await tabBResetState.markResetApplied(pending.epoch);

    // Yet another election (e.g. tab B closes) must not wipe again.
    const tabCResetState = createResetStateStore({ store, dbId: DB_ID, now: () => 1_000_000 });
    await expect(tabCResetState.resolvePendingReset()).resolves.toBeUndefined();
  });

  it("a new clean request after an applied reset triggers another wipe", async () => {
    const { requestReload, resetState, store, broadcasts } = createHarness();

    await requestReload({ clean: true });
    const first = await resetState.resolvePendingReset();
    if (!first) throw new Error("Expected a pending reset");
    await resetState.markResetApplied(first.epoch);

    await requestReload({ clean: true });
    const second = await resetState.resolvePendingReset();
    expect(second?.epoch).toBe(broadcasts[1].reloadEpoch);
    expect(second?.epoch).not.toBe(first.epoch);
    expect(store.map.get(appliedKey)).toBe(first.epoch);
  });
});
