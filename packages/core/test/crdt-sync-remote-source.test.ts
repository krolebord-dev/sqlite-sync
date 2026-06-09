import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDbMigrator } from "../src/migrations/migrator";
import type { CrdtStorage } from "../src/sqlite-crdt/crdt-storage";
import {
  createCrdtSyncRemoteSource,
  type EventsPullRequest,
  type EventsPushRequest,
} from "../src/sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue } from "../src/sqlite-crdt/stored-value";

const createStorageMock = (): CrdtStorage =>
  ({
    getEventsBatch: () => ({ events: [], hasMore: false, nextSyncId: 0 }),
    enqueueLocalEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    enqueueOwnEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    enqueueRemoteEvents: () => ({ beforeSyncId: 0, afterSyncId: 0, processed: Promise.resolve() }),
    applyOwnEvent: () => {},
    dispatchEventsApplied: () => {},
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
});
