import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDbMigrator } from "../src/migrations/migrator";
import type { CrdtStorage } from "../src/sqlite-crdt/crdt-storage";
import {
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
    vi.useRealTimers();
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
    await vi.waitFor(() => expect(source.pullEvents).toHaveBeenCalledTimes(3));

    expect(pullRequests).toEqual([
      { afterSyncId: 0, excludeNodeId: "local-node" },
      { afterSyncId: 0, excludeNodeId: "local-node" },
      { afterSyncId: 0, excludeNodeId: "local-node" },
    ]);
    expect(remoteSource.getState().remoteState).toBe("online");
  });

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
    sources?: ReturnType<typeof createSource>[];
    storage?: CrdtStorage;
    pushSyncId?: StoredValue<number>;
    pullSyncId?: StoredValue<number>;
    remoteFactory?: CreateRemoteSourceFactory;
  }) => {
    let attempt = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (attempt++ % 2 === 0 ? 1 : 0));

    const sources = [...(opts.sources ?? [])];
    return createCrdtSyncRemoteSource({
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
  };

  describe("after reconnecting", () => {
    const remoteEvent = {
      schema_version: 1,
      timestamp: "0000000000001-0000-node-a",
      type: "item-created" as const,
      dataset: "todo",
      item_id: "1",
      payload: "{}",
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

    const createStorageWithEventToPush = () =>
      ({
        ...createStorageMock(),
        getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
          afterSyncId < 1
            ? { events: [remoteEvent], hasMore: false, nextSyncId: 1 }
            : { events: [], hasMore: false, nextSyncId: afterSyncId },
      }) as unknown as CrdtStorage;

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

    it("pulls missed events and pushes pending ones when the source reports a reconnect", async () => {
      const pullSyncId = createStoredValue({ initialValue: 0 });
      const pushSyncId = createStoredValue({ initialValue: 0 });
      let hasPendingEvent = false;
      const storage = {
        ...createStorageMock(),
        getEventsBatch: ({ afterSyncId }: { afterSyncId: number }) =>
          hasPendingEvent && afterSyncId < 1
            ? { events: [remoteEvent], hasMore: false, nextSyncId: 1 }
            : { events: [], hasMore: false, nextSyncId: afterSyncId },
      } as unknown as CrdtStorage;
      const source = createSource({});
      let reportReconnect = () => {};
      const remoteSource = setup({
        storage,
        pullSyncId,
        pushSyncId,
        remoteFactory: ({ onReconnected }) => {
          reportReconnect = onReconnected;
          return source;
        },
      });

      await remoteSource.goOnline();
      await remoteSource.syncWithRemote();
      const pullsBeforeReconnect = source.pullEvents.mock.calls.length;
      expect(source.pushEvents).not.toHaveBeenCalled();

      hasPendingEvent = true;
      source.pullEvents.mockResolvedValueOnce({ events: [remoteEvent], hasMore: false, nextSyncId: 5 });
      reportReconnect();

      await vi.waitFor(() => expect(pullSyncId.current).toBe(5));
      await vi.waitFor(() => expect(pushSyncId.current).toBe(1));
      expect(source.pullEvents).toHaveBeenCalledTimes(pullsBeforeReconnect + 1);
      expect(remoteSource.getState().remoteState).toBe("online");
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
      await remoteSource.goOnline();
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

    it("does not connect while offline", async () => {
      const remoteFactory = vi.fn();
      const remoteSource = setup({ remoteFactory });

      await remoteSource.syncWithRemote();

      expect(remoteFactory).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("offline");
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
      const source = createSource({});
      const connecting = createDeferredPromise<typeof source>();
      const remoteFactory = vi.fn(() => connecting.promise);
      const remoteSource = setup({ remoteFactory });

      const online = remoteSource.goOnline();
      await vi.waitFor(() => expect(remoteFactory).toHaveBeenCalled());
      const offline = remoteSource.goOffline("DISCONNECTED");
      connecting.resolve(source);
      await Promise.all([online, offline]);

      await vi.waitFor(() => expect(source.disconnect).toHaveBeenCalled());
      expect(source.pullEvents).not.toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("disposes while a connection attempt never settles", async () => {
      const remoteSource = setup({ remoteFactory: () => new Promise<never>(() => {}) });

      const online = remoteSource.goOnline();
      await remoteSource.dispose();
      await online;

      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("goes offline when a state listener calls goOffline while connecting", async () => {
      const remoteSource = setup({ remoteFactory: () => new Promise<never>(() => {}) });
      remoteSource.addEventListener("state-changed", (event) => {
        if (event.payload === "pending") {
          remoteSource.goOffline("DISCONNECTED");
        }
      });

      await remoteSource.goOnline();

      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("goes offline without waiting for a reconnect attempt that never settles", async () => {
      const previous = createSource({});
      let factoryCalls = 0;
      const remoteSource = setup({
        remoteFactory: () => (factoryCalls++ === 0 ? previous : new Promise<never>(() => {})),
      });
      await remoteSource.goOnline();

      const offline = remoteSource.goOffline("DISCONNECTED");
      const online = remoteSource.goOnline();
      await remoteSource.goOffline("DISCONNECTED");
      await Promise.all([offline, online]);

      expect(factoryCalls).toBe(1);
      expect(remoteSource.getState().remoteState).toBe("offline");
    });

    it("shows a reconnect started by disconnect as pending", async () => {
      const previous = createSource({});
      previous.disconnect.mockImplementation(() => {
        remoteSource.goOnline();
      });
      let factoryCalls = 0;
      const remoteSource = setup({
        remoteFactory: () => (factoryCalls++ === 0 ? previous : new Promise<never>(() => {})),
      });
      await remoteSource.goOnline();

      await remoteSource.goOffline("DISCONNECTED");

      expect(previous.disconnect).toHaveBeenCalled();
      expect(remoteSource.getState().remoteState).toBe("pending");
    });

    it("shares one connection attempt between concurrent goOnline calls", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const remoteFactory = vi.fn(async (): Promise<ReturnType<typeof createSource>> => {
        throw new Error("connect failed");
      });
      const remoteSource = setup({ remoteFactory });

      await Promise.all([remoteSource.goOnline(), remoteSource.goOnline(), remoteSource.goOnline()]);
      expect(remoteFactory).toHaveBeenCalledTimes(1);
      expect(remoteSource.getState().remoteState).toBe("offline");

      await remoteSource.goOnline();
      expect(remoteFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe("random interleavings", () => {
    type Outcome = "resolve" | "reject" | "hang";
    type Action =
      | { type: "goOnline" | "goOffline" | "dispose" | "step" }
      | { type: "eventsAvailable"; connection: number; caughtUp: boolean };

    const actionArb: fc.Arbitrary<Action> = fc.oneof(
      { arbitrary: fc.constant({ type: "goOnline" } as const), weight: 3 },
      { arbitrary: fc.constant({ type: "goOffline" } as const), weight: 2 },
      { arbitrary: fc.constant({ type: "dispose" } as const), weight: 1 },
      { arbitrary: fc.constant({ type: "step" } as const), weight: 5 },
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
              getEventHlcAccumulator: () => "local-sum",
            } as unknown as CrdtStorage;

            const remoteSource = createCrdtSyncRemoteSource({
              bufferSize: 50,
              storage,
              migrator,
              pullSyncId,
              pushSyncId: createStoredValue({ initialValue: 0 }),
              nodeId: "local-node",
              remoteFactory: ({ onEventsAvailable }) => {
                const id = callbacks.length;
                callbacks.push(onEventsAvailable);
                return settle(() => {
                  disconnects.set(id, 0);
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
                    disconnect: () => {
                      disconnects.set(id, (disconnects.get(id) ?? 0) + 1);
                    },
                  };
                });
              },
            });

            let deSyncs = 0;
            remoteSource.addEventListener("de-sync-detected", () => deSyncs++);

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
              } else if (callbacks.length > 0) {
                const id = action.connection % callbacks.length;
                const deSyncsBefore = deSyncs;
                callbacks[id]?.({
                  newSyncId: action.caughtUp ? pullSyncId.current : pullSyncId.current + 1,
                  remoteEventHlcSum: "remote-sum",
                });
                if (!isLive(id) && deSyncs !== deSyncsBefore) {
                  violations.push(`de-sync detected from closed connection ${id}`);
                }
              }

              if (remoteSource.getState().remoteState === "online" && ![...disconnects.values()].includes(0)) {
                violations.push("online without a live source");
              }
              if (action.type !== "step") {
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
