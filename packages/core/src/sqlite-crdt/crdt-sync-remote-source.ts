import retryAsPromised from "retry-as-promised";
import type { SyncDbMigrator } from "../migrations/migrator";
import { createTypedEventTarget, ensureSingletonExecution, tryCatchAsync } from "../utils";
import type { EventsPullResponse } from "../worker-db/worker-common";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage } from "./crdt-storage";
import type { StoredValue } from "./stored-value";

type CrdtSyncRemoteSourceConfig = {
  bufferSize: number;
  storage: CrdtStorage;
  migrator: SyncDbMigrator;
  pullSyncId: StoredValue<number>;
  pushSyncId: StoredValue<number>;
  nodeId: string;
  remoteFactory?: CreateRemoteSourceFactory;
};

export type EventsPullRequest = {
  afterSyncId: number;
  excludeNodeId?: string;
};

export type EventsPushRequest = {
  nodeId: string;
  events: (PendingCrdtEvent & { schema_version: number })[];
};
export type EventsPushResponse = {
  ok: boolean;
};

export type CrdtSyncRemoteSource = ReturnType<typeof createCrdtSyncRemoteSource>;

export type CreateRemoteSourceFactory = (opts: {
  onEventsAvailable: (newSyncId: number) => void;
}) => RemoteSource | Promise<RemoteSource>;

type RemoteSource = {
  pullEvents: (request: EventsPullRequest) => Promise<EventsPullResponse>;
  pushEvents: (request: EventsPushRequest) => Promise<EventsPushResponse>;
  disconnect?: () => void | Promise<void>;
};

type RemoteSourceState =
  | {
      type: "pending";
    }
  | {
      type: "offline";
      reason: OfflineReason;
    }
  | {
      type: "online";
      source: RemoteSource;
    };

export type OfflineReason =
  | "NOT_INITIALIZED"
  | "INITIALIZATION_FAILED"
  | "REMOTE_PUSH_ERROR"
  | "REMOTE_PULL_ERROR"
  | "DISCONNECTED";

export const createCrdtSyncRemoteSource = ({
  bufferSize,
  storage,
  migrator,
  pullSyncId,
  pushSyncId,
  nodeId,
  remoteFactory,
}: CrdtSyncRemoteSourceConfig) => {
  const eventTarget = createTypedEventTarget<{
    "state-changed": RemoteSourceState["type"];
  }>();

  let remoteState: RemoteSourceState = { type: "offline", reason: "NOT_INITIALIZED" };

  const setRemoteState = (state: RemoteSourceState) => {
    remoteState = state;
    eventTarget.dispatchEvent("state-changed", state.type);
  };

  const initRemote = ensureSingletonExecution(
    async () => {
      if (remoteState.type === "pending") {
        return;
      }
      if (remoteState.type !== "offline") {
        return;
      }

      if (!remoteFactory) {
        console.warn("Remote source factory not provided. Going offline.");
        setRemoteState({ type: "offline", reason: "NOT_INITIALIZED" });
        return;
      }

      setRemoteState({ type: "pending" });

      const factoryResult = await tryCatchAsync(async () => {
        return await remoteFactory?.({
          onEventsAvailable: (newSyncId: number) => {
            if (newSyncId <= pullSyncId.current) {
              return;
            }
            pullEvents({ includeSelf: false });
          },
        });
      });

      if (!factoryResult.success) {
        setRemoteState({ type: "offline", reason: "INITIALIZATION_FAILED" });
        console.warn("Failed to create remote source", factoryResult.error);
        return;
      }

      setRemoteState({
        type: "online",
        source: factoryResult.data,
      });
    },
    { queueReExecution: false },
  );

  const syncWithRemote = ensureSingletonExecution(
    async () => {
      if (remoteState.type !== "online") {
        return;
      }

      await pullEvents();
      await startPushingEvents();
    },
    { queueReExecution: false },
  );

  const goOffline = ensureSingletonExecution(
    async (reason: OfflineReason) => {
      if (remoteState.type !== "online") {
        return;
      }
      const source = remoteState.source;

      setRemoteState({ type: "pending" });

      const disconnectResult = await tryCatchAsync(async () => {
        return await source.disconnect?.();
      });

      if (!disconnectResult.success) {
        console.warn("Error while disconnecting from remote source", disconnectResult.error);
      }

      setRemoteState({ type: "offline", reason });
    },
    { queueReExecution: false },
  );

  const goOnline = async () => {
    if (remoteState.type !== "online") {
      await initRemote();
    }

    if (remoteState.type === "online") {
      await syncWithRemote();
    }
  };

  let requestedPullSyncId: number | null = null;
  let pullPromise: Promise<void> | null = null;
  const pullEvents = (request?: { afterSyncId?: number; includeSelf?: boolean }) => {
    if (remoteState.type !== "online") {
      return Promise.resolve();
    }

    const afterSyncId = request?.afterSyncId ?? pullSyncId.current;

    if (pullPromise) {
      if (!requestedPullSyncId || requestedPullSyncId < afterSyncId) {
        requestedPullSyncId = afterSyncId;
      }
      return pullPromise;
    }

    pullPromise = pullAllEvents({
      afterSyncId,
      excludeNodeId: request?.includeSelf ? undefined : nodeId,
    })
      .catch((error) => {
        console.error("Error pulling events. Going offline.", error);
        goOffline("REMOTE_PULL_ERROR");
      })
      .finally(() => {
        pullPromise = null;

        if (requestedPullSyncId && requestedPullSyncId > pullSyncId.current) {
          pullEvents({ afterSyncId: requestedPullSyncId });
          requestedPullSyncId = null;
        }
      });
    return pullPromise;
  };

  const pullAllEvents = async (opts: EventsPullRequest) => {
    let hasMore = true;
    let afterSyncId = opts.afterSyncId;
    while (hasMore) {
      if (remoteState.type !== "online") {
        return;
      }
      const source = remoteState.source;

      const response = await retryAsPromised(
        () =>
          source.pullEvents({
            ...opts,
            afterSyncId,
          }),
        {
          max: 3,
          backoffBase: 100,
          backoffExponent: 1.5,
          backoffJitter: 150,
          timeout: 10000,
        },
      );
      hasMore = response.hasMore;
      afterSyncId = response.nextSyncId;

      if (response.events) {
        storage.enqueueRemoteEvents(
          response.events.map((x) => {
            if (x.schema_version > migrator.currentSchemaVersion) {
              throw new Error(
                `Event schema version ${x.schema_version} is greater than current schema version ${migrator.currentSchemaVersion}`,
              );
            }
            return x;
          }),
        );
      }
      if (response.nextSyncId <= pullSyncId.current) {
        break;
      }
      if (response.nextSyncId > pullSyncId.current) {
        pullSyncId.current = response.nextSyncId;
      }
    }
  };

  const startPushingEvents = ensureSingletonExecution(async () => {
    while (true) {
      const eventsBatch = storage.getEventsBatch({
        status: "applied",
        afterSyncId: pushSyncId.current,
        excludeOrigin: "remote",
        limit: bufferSize,
      });
      if (eventsBatch.events.length === 0) {
        break;
      }

      if (remoteState.type !== "online") {
        break;
      }
      const source = remoteState.source;

      const migratedEvents = migrator.migrateEvents(eventsBatch.events);

      if (migratedEvents.length > 0) {
        try {
          await retryAsPromised(
            () =>
              source.pushEvents({
                nodeId,
                events: migratedEvents,
              }),
            {
              max: 3,
              backoffBase: 100,
              backoffExponent: 1.5,
              backoffJitter: 150,
              timeout: 10000,
            },
          );
        } catch (error) {
          console.error("Error pushing events. Going offline.", error);
          goOffline("REMOTE_PUSH_ERROR");
          return;
        }
      }

      pushSyncId.current = eventsBatch.nextSyncId;
      if (!eventsBatch.hasMore) {
        break;
      }
    }
  });

  storage.addEventListener("events-applied", () => {
    startPushingEvents();
  });

  const getState = (): "pending" | "offline" | "online" => remoteState.type;

  return {
    goOnline,
    goOffline,
    syncWithRemote,
    getState,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
};
