import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDbMigrator } from "../src/migrations/migrator";
import type { CrdtStorage } from "../src/sqlite-crdt/crdt-storage";
import {
  createCrdtSyncRemoteSource,
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
    enqueueOwnEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    enqueueRemoteEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    applyOwnEvents: () => {},
    checkIsQuiescent: () => true,
    getEventHlcAccumulator: () => null,
    addEventListener: () => ({ unsubscribe: () => {} }),
    removeEventListener: () => {},
  }) as unknown as CrdtStorage;

const migrator = {
  currentSchemaVersion: 1,
} as SyncDbMigrator;

describe("createCrdtSyncRemoteSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient pull failures", async () => {
    const randomValues = [1, 0, 1, 0];
    vi.spyOn(Math, "random").mockImplementation(() => randomValues.shift() ?? 0);

    const pullRequests: EventsPullRequest[] = [];
    const source = {
      pullEvents: vi.fn(async (request: EventsPullRequest) => {
        pullRequests.push(request);
        if (pullRequests.length < 3) {
          throw new Error(`pull failed ${pullRequests.length}`);
        }
        return { events: [], hasMore: false, nextSyncId: 0 };
      }),
      pushEvents: vi.fn(async (_request: EventsPushRequest) => ({ ok: true })),
    };

    const remoteSource = createCrdtSyncRemoteSource({
      bufferSize: 50,
      storage: createStorageMock(),
      migrator,
      pullSyncId: createStoredValue({ initialValue: 0 }),
      pushSyncId: createStoredValue({ initialValue: 0 }),
      nodeId: "local-node",
      remoteFactory: () => source,
    });

    await remoteSource.goOnline();

    expect(source.pullEvents).toHaveBeenCalledTimes(3);
    expect(pullRequests).toEqual([
      { afterSyncId: 0, excludeNodeId: "local-node" },
      { afterSyncId: 0, excludeNodeId: "local-node" },
      { afterSyncId: 0, excludeNodeId: "local-node" },
    ]);
    expect(remoteSource.getState().remoteState).toBe("online");
  });

  describe("after reconnecting", () => {
    const remoteEvent = {
      schema_version: 1,
      timestamp: "0000000000001-0000-node-a",
      type: "item-created" as const,
      dataset: "todo",
      item_id: "1",
      payload: "{}",
    };

    const emptyPull = async () => ({ events: [], hasMore: false, nextSyncId: 0 });

    const createSource = (overrides: {
      pullEvents?: (request: EventsPullRequest) => Promise<EventsPullResponse>;
      pushEvents?: (request: EventsPushRequest) => Promise<EventsPushResponse>;
    }) => ({
      pullEvents: vi.fn(overrides.pullEvents ?? emptyPull),
      pushEvents: vi.fn(overrides.pushEvents ?? (async () => ({ ok: true }))),
      disconnect: vi.fn(),
    });

    const setup = (opts: {
      sources: ReturnType<typeof createSource>[];
      storage?: CrdtStorage;
      pushSyncId?: StoredValue<number>;
      pullSyncId?: StoredValue<number>;
    }) => {
      let attempt = 0;
      vi.spyOn(Math, "random").mockImplementation(() => (attempt++ % 2 === 0 ? 1 : 0));

      const sources = [...opts.sources];
      return createCrdtSyncRemoteSource({
        bufferSize: 50,
        storage: opts.storage ?? createStorageMock(),
        migrator,
        pullSyncId: opts.pullSyncId ?? createStoredValue({ initialValue: 0 }),
        pushSyncId: opts.pushSyncId ?? createStoredValue({ initialValue: 0 }),
        nodeId: "local-node",
        remoteFactory: () => {
          const source = sources.shift();
          if (!source) {
            throw new Error("No more sources");
          }
          return source;
        },
      });
    };

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
      const storage = {
        ...createStorageMock(),
        getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
          afterSyncId < 1
            ? { events: [remoteEvent], hasMore: false, nextSyncId: 1 }
            : { events: [], hasMore: false, nextSyncId: afterSyncId },
      } as unknown as CrdtStorage;
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
});
