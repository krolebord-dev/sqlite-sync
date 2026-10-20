import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDbMigrator } from "../src/migrations/migrator";
import type { CrdtStorage } from "../src/sqlite-crdt/crdt-storage";
import {
  type CrdtSyncRemoteSource,
  type CreateRemoteSourceFactory,
  createCrdtSyncRemoteSource,
  type EventsAvailable,
  type EventsPullRequest,
  type EventsPushRequest,
  type EventsPushResponse,
} from "../src/sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue, type StoredValue } from "../src/sqlite-crdt/stored-value";
import { createDeferredPromise } from "../src/utils";
import type { EventsPullResponse } from "../src/worker-db/worker-common";

const createStorageMock = (): CrdtStorage =>
  ({
    getEventsBatch: () => ({ events: [], hasMore: false, nextSyncId: 0 }),
    enqueueLocalEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    enqueueRemoteEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    applyOwnEvents: () => {},
    checkIsQuiescent: () => true,
    getStateHash: () => null,
    addEventListener: () => ({ unsubscribe: () => {} }),
    removeEventListener: () => {},
  }) as unknown as CrdtStorage;

const migrator = {
  currentSchemaVersion: 1,
} as SyncDbMigrator;

describe("createCrdtSyncRemoteSource", () => {
  const created: CrdtSyncRemoteSource[] = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((remoteSource) => remoteSource.dispose()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const emptyPull = async () => ({ events: [], hasMore: false, nextSyncId: 0 });

  const createSource = (overrides: {
    pullEvents?: (request: EventsPullRequest) => Promise<EventsPullResponse>;
    pushEvents?: (request: EventsPushRequest) => Promise<EventsPushResponse>;
    ping?: () => Promise<void>;
  }) => ({
    pullEvents: vi.fn(overrides.pullEvents ?? emptyPull),
    pushEvents: vi.fn(overrides.pushEvents ?? (async () => ({ ok: true }))),
    ping: overrides.ping && vi.fn(overrides.ping),
    disconnect: vi.fn(),
  });

  const setup = (opts: {
    sources?: ReturnType<typeof createSource>[];
    storage?: CrdtStorage;
    pushSyncId?: StoredValue<number>;
    pullSyncId?: StoredValue<number>;
    remoteFactory?: CreateRemoteSourceFactory;
  }) => {
    let attempt = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (attempt++ % 2 === 0 ? 1 : 0));

    const sources = [...(opts.sources ?? [])];
    const remoteSource = createCrdtSyncRemoteSource({
      bufferSize: 50,
      storage: opts.storage ?? createStorageMock(),
      migrator,
      pullSyncId: opts.pullSyncId ?? createStoredValue({ initialValue: 0 }),
      pushSyncId: opts.pushSyncId ?? createStoredValue({ initialValue: 0 }),
      nodeId: "local-node",
      remoteFactory:
        opts.remoteFactory ??
        (() => {
          const source = sources.shift();
          if (!source) {
            throw new Error("No more sources");
          }
          return source;
        }),
    });
    created.push(remoteSource);
    return remoteSource;
  };

  const hangingPull = () => new Promise<never>(() => {});

  const setupClosable = (sources: ReturnType<typeof createSource>[] = []) => {
    const closers: ((error?: unknown) => void)[] = [];
    const remoteFactory = vi.fn<CreateRemoteSourceFactory>(({ onClosed }) => {
      closers.push(onClosed);
      return sources.shift() ?? createSource({});
    });
    return { remoteSource: setup({ remoteFactory }), remoteFactory, closers };
  };

  const remoteEvent = {
    schema_version: 1,
    timestamp: "0000000000001-0000-node-a",
    type: "item-created" as const,
    dataset: "todo",
    item_id: "1",
    payload: "{}",
  };

  const createStorageWithEventToPush = () =>
    ({
      ...createStorageMock(),
      getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
        afterSyncId < 1
          ? { events: [remoteEvent], hasMore: false, nextSyncId: 1 }
          : { events: [], hasMore: false, nextSyncId: afterSyncId },
    }) as unknown as CrdtStorage;

  describe("after reconnecting", () => {
    it("ignores a pull failure from the previous connection", async () => {
      const stalePull = createDeferredPromise<EventsPullResponse>();
      const previous = createSource({ pullEvents: () => stalePull.promise });
      const current = createSource({});
      const remoteSource = setup({ sources: [previous, current] });

      const previousSync = remoteSource.goOnline();
      await vi.waitFor(() => expect(previous.pullEvents).toHaveBeenCalled());
      await remoteSource.goOffline("DISCONNECTED");

      const currentSync = remoteSource.goOnline();
      stalePull.reject(new Error("socket closed"));
      await Promise.all([previousSync, currentSync]);

      expect(current.pullEvents).toHaveBeenCalled();
      expect(current.disconnect).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("ignores a push failure from the previous connection and pushes on the current one", async () => {
      const pushSyncId = createStoredValue({ initialValue: 0 });
      const storage = createStorageWithEventToPush();
      const stalePush = createDeferredPromise<EventsPushResponse>();
      const previous = createSource({ pushEvents: () => stalePush.promise });
      const current = createSource({});
      const remoteSource = setup({ sources: [previous, current], storage, pushSyncId });

      const previousSync = remoteSource.goOnline();
      await vi.waitFor(() => expect(previous.pushEvents).toHaveBeenCalled());
      await remoteSource.goOffline("DISCONNECTED");

      const currentSync = remoteSource.goOnline();
      stalePush.reject(new Error("socket closed"));
      await Promise.all([previousSync, currentSync]);

      await vi.waitFor(() => expect(current.pushEvents).toHaveBeenCalled());
      expect(current.disconnect).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("online");
      expect(pushSyncId.current).toBe(1);
    });

    it("does not wait for a push on the previous connection that never settles", async () => {
      vi.useFakeTimers();
      const pushSyncId = createStoredValue({ initialValue: 0 });
      const previous = createSource({ pushEvents: () => new Promise<never>(() => {}) });
      const current = createSource({});
      const remoteSource = setup({ sources: [previous, current], storage: createStorageWithEventToPush(), pushSyncId });
      vi.spyOn(Math, "random").mockReturnValue(1);

      const previousSync = remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(0);
      expect(previous.pushEvents).toHaveBeenCalled();
      await remoteSource.goOffline("DISCONNECTED");

      await Promise.all([previousSync, remoteSource.goOnline()]);
      await vi.advanceTimersByTimeAsync(0);

      expect(current.pushEvents).toHaveBeenCalled();
      expect(previous.pushEvents).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("online");
      expect(pushSyncId.current).toBe(1);
    });

    it("does not apply events pulled by the previous connection", async () => {
      const pullSyncId = createStoredValue({ initialValue: 0 });
      const storage = createStorageMock();
      const enqueueRemoteEvents = vi.spyOn(storage, "enqueueRemoteEvents");
      const stalePull = createDeferredPromise<EventsPullResponse>();
      const previous = createSource({ pullEvents: () => stalePull.promise });
      const current = createSource({});
      const remoteSource = setup({ sources: [previous, current], storage, pullSyncId });

      const previousSync = remoteSource.goOnline();
      await vi.waitFor(() => expect(previous.pullEvents).toHaveBeenCalled());
      await remoteSource.goOffline("DISCONNECTED");

      const currentSync = remoteSource.goOnline();
      stalePull.resolve({ events: [remoteEvent], hasMore: false, nextSyncId: 5 });
      await Promise.all([previousSync, currentSync]);

      expect(enqueueRemoteEvents).not.toHaveBeenCalledWith([remoteEvent]);
      expect(pullSyncId.current).toBe(0);
    });

    it("does not apply events pulled by the previous connection when the factory reuses the source", async () => {
      const pullSyncId = createStoredValue({ initialValue: 0 });
      const storage = createStorageMock();
      const enqueueRemoteEvents = vi.spyOn(storage, "enqueueRemoteEvents");
      const stalePull = createDeferredPromise<EventsPullResponse>();
      const shared = createSource({});
      shared.pullEvents.mockImplementationOnce(() => stalePull.promise);
      const remoteSource = setup({ sources: [shared, shared], storage, pullSyncId });

      const previousSync = remoteSource.goOnline();
      await vi.waitFor(() => expect(shared.pullEvents).toHaveBeenCalled());
      await remoteSource.goOffline("DISCONNECTED");

      const currentSync = remoteSource.goOnline();
      stalePull.resolve({ events: [remoteEvent], hasMore: false, nextSyncId: 5 });
      await Promise.all([previousSync, currentSync]);

      expect(shared.pullEvents).toHaveBeenCalledTimes(2);
      expect(enqueueRemoteEvents).not.toHaveBeenCalledWith([remoteEvent]);
      expect(pullSyncId.current).toBe(0);
    });
  });

  describe("syncWithRemote", () => {
    it.each(["processed", "disconnected"])("waits for pulled events until %s", async (outcome) => {
      const processing = createDeferredPromise<void>();
      const enqueued = createDeferredPromise<void>();
      const storage = createStorageMock();
      const source = createSource({});
      const pullSyncId = createStoredValue({ initialValue: 0 });
      const remoteSource = setup({ sources: [source], storage, pullSyncId });
      await remoteSource.goOnline();
      await remoteSource.syncWithRemote();

      vi.spyOn(storage, "enqueueRemoteEvents").mockImplementation(() => {
        enqueued.resolve();
        return { beforeSyncId: 0, afterSyncId: 1, processed: processing.promise };
      });
      source.pullEvents.mockResolvedValue({
        events: [
          {
            schema_version: 1,
            timestamp: "000000000000001:00000:remote",
            type: "item-created",
            dataset: "todo",
            item_id: "1",
            payload: "{}",
          },
        ],
        hasMore: false,
        nextSyncId: 1,
      });
      let syncFinished = false;
      const syncing = remoteSource.syncWithRemote().then(() => {
        syncFinished = true;
      });
      try {
        await enqueued.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(syncFinished).toBe(false);
        expect(pullSyncId.current).toBe(0);
        if (outcome === "processed") {
          processing.resolve();
        } else {
          await remoteSource.goOffline("DISCONNECTED");
        }
        await syncing;
        expect(pullSyncId.current).toBe(outcome === "processed" ? 1 : 0);
      } finally {
        processing.resolve();
        await remoteSource.dispose();
        await syncing;
      }
    });

    it("pulls again after a pull that was already in flight", async () => {
      const inFlight = createDeferredPromise<EventsPullResponse>();
      let pulls = 0;
      const source = createSource({ pullEvents: () => (pulls++ === 0 ? inFlight.promise : emptyPull()) });
      const remoteSource = setup({ sources: [source] });
      void remoteSource.goOnline();
      await vi.waitFor(() => expect(source.pullEvents).toHaveBeenCalledTimes(1));

      const syncing = remoteSource.syncWithRemote();
      inFlight.resolve({ events: [], hasMore: false, nextSyncId: 0 });
      await syncing;

      expect(source.pullEvents).toHaveBeenCalledTimes(2);
    });

    it("pushes events applied while a push was already in flight", async () => {
      const event = {
        schema_version: 1,
        timestamp: "0000000000001-0000-local-node",
        type: "item-created" as const,
        dataset: "todo",
        item_id: "1",
        payload: "{}",
      };
      let lastSyncId = 1;
      const storage = {
        ...createStorageMock(),
        getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
          afterSyncId < lastSyncId
            ? { events: [event], hasMore: false, nextSyncId: lastSyncId }
            : { events: [], hasMore: false, nextSyncId: afterSyncId },
      } as unknown as CrdtStorage;
      const inFlight = createDeferredPromise<EventsPushResponse>();
      let pushes = 0;
      const source = createSource({
        pushEvents: () =>
          pushes++ === 0
            ? inFlight.promise
            : new Promise<EventsPushResponse>((resolve) => setTimeout(() => resolve({ ok: true }), 0)),
      });
      const pushSyncId = createStoredValue({ initialValue: 0 });
      const remoteSource = setup({ sources: [source], storage, pushSyncId });
      await remoteSource.goOnline();
      await vi.waitFor(() => expect(source.pushEvents).toHaveBeenCalledTimes(1));

      lastSyncId = 2;
      const syncing = remoteSource.syncWithRemote();
      await vi.waitFor(() => expect(source.pullEvents).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight.resolve({ ok: true });
      await syncing;

      expect(source.pushEvents).toHaveBeenCalledTimes(2);
      expect(pushSyncId.current).toBe(2);
    });

    it("does not connect before goOnline", async () => {
      const remoteFactory = vi.fn();
      const remoteSource = setup({ remoteFactory });

      await remoteSource.syncWithRemote();

      expect(remoteFactory).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("reconnects right away after a pull error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = createSource({ pullEvents: () => Promise.reject(new Error("pull failed")) });
      const next = createSource({});
      const remoteSource = setup({ sources: [failing, next] });
      await remoteSource.goOnline();
      expect(failing.disconnect).toHaveBeenCalledTimes(1);

      await remoteSource.syncWithRemote();

      expect(remoteSource.getState().remoteState).toBe("online");
      await vi.waitFor(() => expect(next.pullEvents).toHaveBeenCalled());
    });

    it("does not reconnect after goOffline", async () => {
      const remoteFactory = vi.fn(() => createSource({}));
      const remoteSource = setup({ remoteFactory });
      await remoteSource.goOnline();
      await remoteSource.goOffline("DISCONNECTED");

      await remoteSource.syncWithRemote();

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("does not reconnect after a schema version mismatch", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const remoteFactory = vi.fn(() =>
        createSource({
          pullEvents: async () => ({
            events: [
              {
                schema_version: 2,
                timestamp: "000000000000001:00000:remote",
                type: "item-created",
                dataset: "todo",
                item_id: "1",
                payload: "{}",
              },
            ],
            hasMore: false,
            nextSyncId: 1,
          }),
        }),
      );
      const remoteSource = setup({ remoteFactory });
      await remoteSource.goOnline();
      await vi.waitFor(() => expect(remoteSource.getState().remoteState).toBe("offline"));

      await remoteSource.syncWithRemote();

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState()).toMatchObject({ remoteState: "offline", schemaVersionMismatched: true });
    });

    it("does not start another connection while one is connecting", async () => {
      const remoteFactory = vi.fn(() => createSource({ pullEvents: hangingPull }));
      const remoteSource = setup({ remoteFactory });
      void remoteSource.goOnline();

      void remoteSource.syncWithRemote();

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("connecting");
    });
  });

  describe("reconnecting", () => {
    it("shows the remote as connecting until the first request succeeds", async () => {
      const pulled = createDeferredPromise<EventsPullResponse>();
      const remoteSource = setup({ sources: [createSource({ pullEvents: () => pulled.promise })] });

      const online = remoteSource.goOnline();
      expect(remoteSource.getState().remoteState).toBe("connecting");

      pulled.resolve({ events: [], hasMore: false, nextSyncId: 0 });
      await online;
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("stays offline when the connection closes just after the first response arrives", async () => {
      const pulled = createDeferredPromise<EventsPullResponse>();
      const source = createSource({ pullEvents: () => pulled.promise });
      const remoteSource = setup({ sources: [source] });
      const online = remoteSource.goOnline();
      await vi.waitFor(() => expect(source.pullEvents).toHaveBeenCalled());

      pulled.resolve({ events: [], hasMore: false, nextSyncId: 0 });
      queueMicrotask(() => void remoteSource.goOffline("DISCONNECTED"));
      await online;

      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("reconnects with backoff after the source closes and catches up", async () => {
      vi.useFakeTimers();
      const first = createSource({});
      const second = createSource({});
      const { remoteSource, remoteFactory, closers } = setupClosable([first, second]);
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();

      closers[0]?.();
      expect(remoteSource.getState().remoteState).toBe("connecting");
      expect(first.disconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(remoteFactory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      expect(second.pullEvents).toHaveBeenCalledWith({ afterSyncId: 0, excludeNodeId: "local-node" });
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("stays connecting through failed retries until it is back online", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const closers: ((error?: unknown) => void)[] = [];
      let failing = false;
      const remoteSource = setup({
        remoteFactory: ({ onClosed }) => {
          closers.push(onClosed);
          if (failing) {
            throw new Error("connect failed");
          }
          return createSource({});
        },
      });
      vi.spyOn(Math, "random").mockReturnValue(1);
      const states: string[] = [];
      remoteSource.addEventListener("state-changed", (event) => states.push(event.payload));
      await remoteSource.goOnline();

      failing = true;
      closers[0]?.();
      await vi.advanceTimersByTimeAsync(3_000);
      failing = false;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(closers).toHaveLength(4);
      expect(states).toEqual(["connecting", "online", "connecting", "online"]);
    });

    it("doubles the backoff while attempts fail and restarts it after a stable connection", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const closers: ((error?: unknown) => void)[] = [];
      let failing = true;
      const remoteFactory = vi.fn<CreateRemoteSourceFactory>(({ onClosed }) => {
        closers.push(onClosed);
        if (failing) {
          throw new Error("connect failed");
        }
        return createSource({});
      });
      const remoteSource = setup({ remoteFactory });
      vi.spyOn(Math, "random").mockReturnValue(1);

      await remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteFactory).toHaveBeenCalledTimes(3);

      failing = false;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(remoteFactory).toHaveBeenCalledTimes(4);
      expect(remoteSource.getState().remoteState).toBe("online");

      await vi.advanceTimersByTimeAsync(5_000);
      closers.at(-1)?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(remoteFactory).toHaveBeenCalledTimes(5);
    });

    it("keeps growing the backoff when connections drop right after connecting", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();

      closers[0]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(remoteFactory).toHaveBeenCalledTimes(2);

      closers[1]?.();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteFactory).toHaveBeenCalledTimes(3);
    });

    it("treats a close during the factory call as a failed attempt", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const source = createSource({});
      const remoteSource = setup({
        remoteFactory: ({ onClosed }) => {
          onClosed(new Error("connection refused"));
          return source;
        },
      });

      await remoteSource.goOnline();

      expect(remoteSource.getState().remoteState).toBe("connecting");
      expect(source.disconnect).toHaveBeenCalledTimes(1);
      expect(source.pullEvents).not.toHaveBeenCalled();
    });

    it("times out a request that never settles and reconnects", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const stuck = createSource({ pullEvents: hangingPull });
      const next = createSource({});
      const remoteSource = setup({ sources: [stuck, next] });
      vi.spyOn(Math, "random").mockReturnValue(1);

      const online = remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(10_000);
      await online;
      expect(remoteSource.getState().remoteState).toBe("connecting");
      expect(stuck.disconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(next.pullEvents).toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("skips the backoff on syncWithRemote", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      await remoteSource.goOnline();
      closers[0]?.();

      await remoteSource.syncWithRemote();
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      expect(remoteSource.getState().remoteState).toBe("online");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
    });

    it("restarts the backoff on syncWithRemote", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();
      closers[0]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      closers[1]?.();

      await remoteSource.syncWithRemote();
      expect(remoteFactory).toHaveBeenCalledTimes(3);
      closers[2]?.();

      await vi.advanceTimersByTimeAsync(999);
      expect(remoteFactory).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteFactory).toHaveBeenCalledTimes(4);
    });

    it("waits for syncWithRemote after the remote rejects a push", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const remoteFactory = vi.fn(() => createSource({ pushEvents: async () => ({ ok: false }) }));
      const remoteSource = setup({ remoteFactory, storage: createStorageWithEventToPush() });

      await remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");

      await remoteSource.syncWithRemote();
      expect(remoteFactory).toHaveBeenCalledTimes(2);
    });

    it("keeps deSynced across reconnects", async () => {
      vi.useFakeTimers();
      let onApplyFailed = () => {};
      const storage = {
        ...createStorageMock(),
        addEventListener: (type: string, listener: () => void) => {
          if (type === "remote-event-apply-failed") {
            onApplyFailed = listener;
          }
          return { unsubscribe: () => {} };
        },
      } as unknown as CrdtStorage;
      const closers: ((error?: unknown) => void)[] = [];
      const remoteSource = setup({
        storage,
        remoteFactory: ({ onClosed }) => {
          closers.push(onClosed);
          return createSource({});
        },
      });
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();

      onApplyFailed();
      closers[0]?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(remoteSource.getState()).toMatchObject({ remoteState: "online", deSynced: true });
    });

    it("does not reconnect after goOffline during the backoff", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      await remoteSource.goOnline();
      closers[0]?.();

      await remoteSource.goOffline("DISCONNECTED");
      expect(remoteSource.getState().remoteState).toBe("offline");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("does not reconnect after a schema version mismatch", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const remoteFactory = vi.fn(() =>
        createSource({
          pullEvents: async () => ({
            events: [
              {
                schema_version: 2,
                timestamp: "000000000000001:00000:remote",
                type: "item-created",
                dataset: "todo",
                item_id: "1",
                payload: "{}",
              },
            ],
            hasMore: false,
            nextSyncId: 1,
          }),
        }),
      );
      const remoteSource = setup({ remoteFactory });

      await remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState()).toMatchObject({ remoteState: "offline", schemaVersionMismatched: true });
    });

    it("does not restart the backoff on a close from a previous connection", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();
      await vi.advanceTimersByTimeAsync(5_000);
      await remoteSource.goOffline("DISCONNECTED");
      await remoteSource.goOnline();

      closers[1]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      closers[0]?.();
      closers[2]?.();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(remoteFactory).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteFactory).toHaveBeenCalledTimes(4);
    });

    it("ignores a close from a previous connection", async () => {
      const previous = createSource({});
      const current = createSource({});
      const { remoteSource, closers } = setupClosable([previous, current]);
      await remoteSource.goOnline();
      await remoteSource.goOffline("DISCONNECTED");
      await remoteSource.goOnline();

      closers[0]?.();

      expect(remoteSource.getState().remoteState).toBe("online");
      expect(current.disconnect).not.toHaveBeenCalled();
    });
  });

  describe("heartbeat", () => {
    it("pings a connection that has been idle", async () => {
      vi.useFakeTimers();
      const source = createSource({ ping: async () => {} });
      const remoteSource = setup({ sources: [source] });
      await remoteSource.goOnline();

      await vi.advanceTimersByTimeAsync(24_999);
      expect(source.ping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(source.ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(source.ping).toHaveBeenCalledTimes(2);
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("does not ping while the remote keeps sending", async () => {
      vi.useFakeTimers();
      const source = createSource({ ping: async () => {} });
      let eventsAvailable: (event: EventsAvailable) => void = () => {};
      const remoteSource = setup({
        remoteFactory: ({ onEventsAvailable }) => {
          eventsAvailable = onEventsAvailable;
          return source;
        },
      });
      await remoteSource.goOnline();

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20_000);
        eventsAvailable({ newSyncId: 0, remoteStateHash: null });
      }

      expect(source.ping).not.toHaveBeenCalled();
    });

    it("replaces a connection whose ping is not answered", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const stuck = createSource({ ping: hangingPull });
      const next = createSource({});
      const remoteFactory = vi.fn<CreateRemoteSourceFactory>().mockReturnValueOnce(stuck).mockReturnValueOnce(next);
      const remoteSource = setup({ remoteFactory });
      vi.spyOn(Math, "random").mockReturnValue(1);
      await remoteSource.goOnline();

      await vi.advanceTimersByTimeAsync(25_000 + 9_999);
      expect(stuck.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stuck.disconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("replaces a connection whose ping fails", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = createSource({ ping: () => Promise.reject(new Error("socket closed")) });
      const remoteFactory = vi
        .fn<CreateRemoteSourceFactory>()
        .mockReturnValueOnce(failing)
        .mockReturnValueOnce(createSource({}));
      const remoteSource = setup({ remoteFactory });
      await remoteSource.goOnline();

      await vi.advanceTimersByTimeAsync(25_000);

      expect(failing.disconnect).toHaveBeenCalledTimes(1);
    });

    it("stops pinging once the connection is closed", async () => {
      vi.useFakeTimers();
      const source = createSource({ ping: async () => {} });
      const remoteSource = setup({ sources: [source] });
      await remoteSource.goOnline();

      await remoteSource.goOffline("DISCONNECTED");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(source.ping).not.toHaveBeenCalled();
    });
  });

  describe("state hash comparison", () => {
    const checkCaughtUp = async (localStateHash: string | null, remoteStateHash: string | null) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let eventsAvailable: (event: EventsAvailable) => void = () => {};
      const remoteSource = setup({
        storage: { ...createStorageMock(), getStateHash: () => localStateHash } as unknown as CrdtStorage,
        remoteFactory: ({ onEventsAvailable }) => {
          eventsAvailable = onEventsAvailable;
          return createSource({});
        },
      });
      const reasons: string[] = [];
      remoteSource.addEventListener("de-sync-detected", (event) => reasons.push(event.payload.reason));
      await remoteSource.goOnline();

      eventsAvailable({ newSyncId: 0, remoteStateHash });

      return { reasons, deSynced: remoteSource.getState().deSynced };
    };

    it("reports a de-sync when caught up with a different hash for the same schema version", async () => {
      expect(await checkCaughtUp("3:0000000000000001", "3:0000000000000002")).toEqual({
        reasons: ["CHECKSUM_MISMATCH"],
        deSynced: true,
      });
    });

    it.each([
      ["matching hashes", "3:0000000000000001", "3:0000000000000001"],
      ["hashes for different schema versions", "3:0000000000000001", "4:0000000000000002"],
      ["a remote without a state hash", "3:0000000000000001", null],
      ["a malformed remote hash", "3:0000000000000001", "0123456789abcdef0123456789abcdef"],
      ["a local storage without a state hash", null, "3:0000000000000002"],
    ])("does not report a de-sync for %s", async (_, localStateHash, remoteStateHash) => {
      expect(await checkCaughtUp(localStateHash, remoteStateHash)).toEqual({ reasons: [], deSynced: false });
    });
  });

  describe("dropConnection", () => {
    it("goes offline and reconnects on the next syncWithRemote", async () => {
      const remoteFactory = vi.fn(() => createSource({}));
      const remoteSource = setup({ remoteFactory });
      await remoteSource.goOnline();

      remoteSource.dropConnection("NETWORK_OFFLINE");
      expect(remoteSource.getState().remoteState).toBe("offline");

      await remoteSource.syncWithRemote();
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("cancels a pending connection attempt", async () => {
      const pending = createSource({ pullEvents: hangingPull });
      const next = createSource({});
      const remoteSource = setup({ sources: [pending, next] });
      void remoteSource.goOnline();

      remoteSource.dropConnection("NETWORK_OFFLINE");
      expect(remoteSource.getState().remoteState).toBe("offline");
      expect(pending.disconnect).toHaveBeenCalledTimes(1);

      await remoteSource.syncWithRemote();
      expect(remoteSource.getState().remoteState).toBe("online");
      await vi.waitFor(() => expect(next.pullEvents).toHaveBeenCalled());
    });

    it("stays offline after goOffline", async () => {
      const remoteFactory = vi.fn(() => createSource({}));
      const remoteSource = setup({ remoteFactory });
      await remoteSource.goOnline();
      await remoteSource.goOffline("DISCONNECTED");

      remoteSource.dropConnection("NETWORK_OFFLINE");
      await remoteSource.syncWithRemote();

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("cancels a scheduled reconnect and waits for syncWithRemote", async () => {
      vi.useFakeTimers();
      const { remoteSource, remoteFactory, closers } = setupClosable();
      await remoteSource.goOnline();
      closers[0]?.();

      remoteSource.dropConnection("NETWORK_OFFLINE");
      expect(remoteSource.getState().remoteState).toBe("offline");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteFactory).toHaveBeenCalledTimes(1);

      await remoteSource.syncWithRemote();
      expect(remoteFactory).toHaveBeenCalledTimes(2);
      expect(remoteSource.getState().remoteState).toBe("online");
    });
  });

  describe("concurrent goOnline and goOffline", () => {
    it("goes online when goOnline is called while goOffline is disconnecting", async () => {
      const disconnecting = createDeferredPromise<void>();
      const previous = createSource({});
      previous.disconnect.mockImplementation(() => disconnecting.promise);
      const current = createSource({});
      const remoteSource = setup({ sources: [previous, current] });
      await remoteSource.goOnline();

      const offline = remoteSource.goOffline("DISCONNECTED");
      const online = remoteSource.goOnline();
      disconnecting.resolve();
      await Promise.all([offline, online]);

      expect(current.pullEvents).toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("online");
    });

    it("stays offline when goOffline is called while goOnline is connecting", async () => {
      const connecting = createDeferredPromise<EventsPullResponse>();
      const source = createSource({ pullEvents: () => connecting.promise });
      const remoteSource = setup({ sources: [source] });

      const online = remoteSource.goOnline();
      const offline = remoteSource.goOffline("DISCONNECTED");
      connecting.resolve({ events: [], hasMore: false, nextSyncId: 0 });
      await Promise.all([online, offline]);

      expect(source.disconnect).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("disposes while a connection attempt never settles", async () => {
      const remoteSource = setup({ sources: [createSource({ pullEvents: hangingPull })] });

      const online = remoteSource.goOnline();
      await remoteSource.dispose();
      await online;

      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("goes offline when a state listener calls goOffline while connecting", async () => {
      const remoteFactory = vi.fn(() => createSource({}));
      const remoteSource = setup({ remoteFactory });
      remoteSource.addEventListener("state-changed", (event) => {
        if (event.payload === "connecting") {
          remoteSource.goOffline("DISCONNECTED");
        }
      });

      await remoteSource.goOnline();

      expect(remoteFactory).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("goes offline without waiting for a reconnect attempt that never settles", async () => {
      const previous = createSource({});
      const reconnecting = createSource({ pullEvents: hangingPull });
      const remoteSource = setup({ sources: [previous, reconnecting] });
      await remoteSource.goOnline();

      const offline = remoteSource.goOffline("DISCONNECTED");
      const online = remoteSource.goOnline();
      await remoteSource.goOffline("DISCONNECTED");
      await Promise.all([offline, online]);

      expect(reconnecting.disconnect).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("shows a reconnect started by disconnect as connecting", async () => {
      const previous = createSource({});
      previous.disconnect.mockImplementation(() => {
        remoteSource.goOnline();
      });
      const remoteSource = setup({ sources: [previous, createSource({ pullEvents: hangingPull })] });
      await remoteSource.goOnline();

      await remoteSource.goOffline("DISCONNECTED");

      expect(previous.disconnect).toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("connecting");
    });

    it("shares one connection attempt between concurrent goOnline calls", async () => {
      const pulled = createDeferredPromise<EventsPullResponse>();
      const remoteFactory = vi.fn(() => createSource({ pullEvents: () => pulled.promise }));
      const remoteSource = setup({ remoteFactory });

      const online = Promise.all([remoteSource.goOnline(), remoteSource.goOnline(), remoteSource.goOnline()]);
      pulled.resolve({ events: [], hasMore: false, nextSyncId: 0 });
      await online;

      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("online");
    });
  });

  describe("random interleavings", () => {
    type Outcome = "resolve" | "reject" | "hang";
    type Action =
      | { type: "goOnline" | "goOffline" | "dispose" | "step" | "advance" }
      | { type: "close"; connection: number }
      | { type: "eventsAvailable"; connection: number; caughtUp: boolean };

    const actionArb: fc.Arbitrary<Action> = fc.oneof(
      { arbitrary: fc.constant({ type: "goOnline" } as const), weight: 3 },
      { arbitrary: fc.constant({ type: "goOffline" } as const), weight: 2 },
      { arbitrary: fc.constant({ type: "dispose" } as const), weight: 1 },
      { arbitrary: fc.constant({ type: "step" } as const), weight: 5 },
      { arbitrary: fc.constant({ type: "advance" } as const), weight: 1 },
      { arbitrary: fc.record({ type: fc.constant("close" as const), connection: fc.nat(4) }), weight: 2 },
      {
        arbitrary: fc.record({
          type: fc.constant("eventsAvailable" as const),
          connection: fc.nat(4),
          caughtUp: fc.boolean(),
        }),
        weight: 3,
      },
    );
    const outcomeArb = fc.oneof(
      { arbitrary: fc.constant<Outcome>("resolve"), weight: 4 },
      { arbitrary: fc.constant<Outcome>("reject"), weight: 1 },
      { arbitrary: fc.constant<Outcome>("hang"), weight: 1 },
    );

    it("never hangs shutdown, disconnects every source once, and ignores closed connections", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.array(actionArb, { minLength: 10, maxLength: 40 }),
          fc.infiniteStream(outcomeArb),
          async (scheduler, actions, outcomes) => {
            const violations: string[] = [];
            const settle = <T>(value: () => T): Promise<T> => {
              const outcome = outcomes.next().value;
              if (outcome === "hang") {
                return new Promise<never>(() => {});
              }
              return scheduler.schedule(Promise.resolve()).then(() => {
                if (outcome === "reject") {
                  throw new Error("remote failure");
                }
                return value();
              });
            };

            const callbacks: ((event: EventsAvailable) => void)[] = [];
            const closers: (() => void)[] = [];
            const disconnects = new Map<number, number>();
            const isLive = (id: number) => disconnects.get(id) === 0;

            const pullSyncId = createStoredValue({ initialValue: 0 });
            const storage = {
              ...createStorageMock(),
              getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
                afterSyncId < 1
                  ? { events: [{ timestamp: "t", item_id: "1" }], hasMore: false, nextSyncId: 1 }
                  : { events: [], hasMore: false, nextSyncId: afterSyncId },
              enqueueRemoteEvents: (events: { item_id: string }[]) => {
                for (const event of events) {
                  if (!isLive(Number(event.item_id))) {
                    violations.push(`applied events from closed connection ${event.item_id}`);
                  }
                }
                return { beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() };
              },
              getStateHash: () => "1:0000000000000001",
            } as unknown as CrdtStorage;

            const remoteSource = createCrdtSyncRemoteSource({
              bufferSize: 50,
              storage,
              migrator,
              pullSyncId,
              pushSyncId: createStoredValue({ initialValue: 0 }),
              nodeId: "local-node",
              remoteFactory: ({ onEventsAvailable, onClosed }) => {
                const id = callbacks.length;
                callbacks.push(onEventsAvailable);
                closers.push(() => onClosed());
                const outcome = outcomes.next().value;
                if (outcome === "reject") {
                  throw new Error("connect failed");
                }
                disconnects.set(id, 0);
                if (outcome === "hang") {
                  onClosed(new Error("connection refused"));
                }
                const use = <T>(response: () => T) => {
                  if (disconnects.get(id) !== 0) {
                    violations.push(`used disconnected source ${id}`);
                  }
                  return settle(response);
                };
                return {
                  pullEvents: () =>
                    use(() => ({
                      events: [
                        {
                          schema_version: 1,
                          timestamp: "t",
                          type: "item-created" as const,
                          dataset: "todo",
                          item_id: String(id),
                          payload: "{}",
                        },
                      ],
                      hasMore: false,
                      nextSyncId: pullSyncId.current + 1,
                    })),
                  pushEvents: () => use(() => ({ ok: true })),
                  ping: () => use(() => undefined),
                  disconnect: () => {
                    disconnects.set(id, (disconnects.get(id) ?? 0) + 1);
                  },
                };
              },
            });

            let deSyncs = 0;
            remoteSource.addEventListener("de-sync-detected", () => deSyncs++);
            let depth = 0;
            remoteSource.addEventListener("state-changed", (event) => {
              const outcome = outcomes.next().value;
              if (outcome === "resolve" || depth > 3) {
                return;
              }
              depth++;
              if (event.payload === "offline" && outcome === "hang") {
                track(remoteSource.goOnline());
              } else if (outcome === "reject") {
                track(remoteSource.goOffline("DISCONNECTED"));
              }
              depth--;
            });

            let unsettled = 0;
            const track = (promise: Promise<void>) => {
              unsettled++;
              promise.then(
                () => unsettled--,
                (error) => violations.push(`transition rejected: ${error}`),
              );
            };

            for (const action of actions) {
              if (action.type === "goOnline") {
                track(remoteSource.goOnline());
              } else if (action.type === "goOffline") {
                track(remoteSource.goOffline("DISCONNECTED"));
              } else if (action.type === "dispose") {
                track(remoteSource.dispose());
              } else if (action.type === "step") {
                if (scheduler.count() > 0) {
                  await scheduler.waitOne();
                }
              } else if (action.type === "advance") {
                await vi.advanceTimersByTimeAsync(5_000);
              } else if (action.type === "close") {
                if (closers.length > 0) {
                  closers[action.connection % closers.length]?.();
                }
              } else if (action.type === "eventsAvailable" && callbacks.length > 0) {
                const id = action.connection % callbacks.length;
                const deSyncsBefore = deSyncs;
                const wasLive = isLive(id);
                callbacks[id]?.({
                  newSyncId: action.caughtUp ? pullSyncId.current : pullSyncId.current + 1,
                  remoteStateHash: "1:0000000000000002",
                });
                if (!wasLive && deSyncs !== deSyncsBefore) {
                  violations.push(`de-sync detected from closed connection ${id}`);
                }
              }

              const hasLiveSource = [...disconnects.values()].includes(0);
              if (remoteSource.getState().remoteState === "online" && !hasLiveSource) {
                violations.push("online without a live source");
              }
              if (remoteSource.getState().remoteState === "offline" && hasLiveSource) {
                violations.push("offline with a live source");
              }
              if (action.type !== "step" && action.type !== "advance") {
                await vi.advanceTimersByTimeAsync(0);
              }
            }

            track(remoteSource.dispose());
            do {
              await scheduler.waitAll();
              await vi.runAllTimersAsync();
            } while (scheduler.count() > 0 || vi.getTimerCount() > 0);

            expect(violations).toEqual([]);
            expect(unsettled).toBe(0);
            for (const [id, count] of disconnects) {
              expect(count, `source ${id} disconnect calls`).toBe(1);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
