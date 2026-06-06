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
  /** Remote sync_id right before the pushed events were enqueued. */
  beforeSyncId?: number;
  /** Remote sync_id right after the pushed events were enqueued. */
  afterSyncId?: number;
};

export type CrdtSyncRemoteSource = ReturnType<typeof createCrdtSyncRemoteSource>;

export type EventsAvailable = {
  newSyncId: number;
  remoteEventHlcSum: string | null;
};

export type CreateRemoteSourceFactory = (opts: {
  onEventsAvailable: (event: EventsAvailable) => void;
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
      if (remoteState.type !== "offline") {
        throw new Error("Remote source is not offline");
      }

      if (!remoteFactory) {
        console.warn("Remote source factory not provided. Going offline.");
        setRemoteState({ type: "offline", reason: "NOT_INITIALIZED" });
        return;
      }

      setRemoteState({ type: "pending" });

      const factoryResult = await tryCatchAsync(async () => {
        return await remoteFactory?.({
          onEventsAvailable: ({ newSyncId, remoteEventHlcSum }) => {
            pullEvents({ remoteSyncId: newSyncId, remoteEventHlcSum, includeSelf: false });
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
  const pullEvents = (request?: {
    remoteSyncId?: number;
    remoteEventHlcSum?: string | null;
    includeSelf?: boolean;
  }) => {
    if (remoteState.type !== "online") {
      return Promise.resolve();
    }

    const remoteSyncId = request?.remoteSyncId;

    if (remoteSyncId !== undefined && remoteSyncId <= pullSyncId.current) {
      // We are already caught up to this broadcast, so there is nothing to pull.
      // This is the quiescent moment to verify we have not diverged from the
      // remote (the check is a no-op unless we are exactly aligned: remoteSyncId
      // === pullSyncId.current).
      checkRemoteConsistency(remoteSyncId, request?.remoteEventHlcSum ?? null);
      return Promise.resolve();
    }

    if (pullPromise) {
      if (remoteSyncId !== undefined && (!requestedPullSyncId || requestedPullSyncId < remoteSyncId)) {
        requestedPullSyncId = remoteSyncId;
      }
      return pullPromise;
    }

    pullPromise = pullAllEvents({
      afterSyncId: pullSyncId.current,
      excludeNodeId: request?.includeSelf ? undefined : nodeId,
    })
      .catch((error) => {
        console.error("Error pulling events. Going offline.", error);
        goOffline("REMOTE_PULL_ERROR");
      })
      .finally(() => {
        pullPromise = null;

        const nextTarget = requestedPullSyncId;
        requestedPullSyncId = null;

        if (nextTarget && nextTarget > pullSyncId.current) {
          pullEvents({ remoteSyncId: nextTarget });
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

  // De-sync detection: when we are exactly caught up to the remote's broadcast
  // sync id and fully quiescent, our applied-event set must equal the remote's,
  // so our HLC checksums must match. A mismatch means the nodes have diverged.
  const checkRemoteConsistency = (remoteSyncId: number, remoteEventHlcSum: string | null) => {
    // A remote with no accumulator gives us nothing to compare against.
    if (remoteEventHlcSum === null) {
      return;
    }

    // Only meaningful when we are exactly caught up: if we are behind we still
    // need to pull; if we are ahead our state covers events the remote checksum
    // does not.
    if (remoteSyncId !== pullSyncId.current) {
      return;
    }

    // Quiescence: the accumulator only matches the remote's when nothing is left
    // to apply locally and no local applied events are still waiting to be pushed
    // (those are in our accumulator but the remote has not seen them yet).
    if (!storage.checkIsQuiescent(pushSyncId.current)) {
      return;
    }

    const localEventHlcSum = storage.getEventHlcAccumulator();
    if (localEventHlcSum === null) {
      return;
    }

    if (localEventHlcSum !== remoteEventHlcSum) {
      console.warn(
        `[sqlite-sync] De-sync detected at syncId ${remoteSyncId}: local HLC checksum ${localEventHlcSum} != remote ${remoteEventHlcSum}. Local and remote have diverged despite being caught up.`,
      );
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

      let response: EventsPushResponse;
      try {
        response = await retryAsPromised(
          () =>
            source.pushEvents({
              nodeId,
              events: eventsBatch.events.map((event) => ({
                schema_version: event.schema_version,
                timestamp: event.timestamp,
                type: event.type,
                dataset: event.dataset,
                item_id: event.item_id,
                payload: event.payload,
              })),
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

      pushSyncId.current = eventsBatch.nextSyncId;

      // Fast-forward the pull cursor: the remote assigns sync ids for the pushed
      // events synchronously, so (beforeSyncId, afterSyncId] contains only this
      // node's own events. If we are caught up to at least beforeSyncId, the skipped
      // range (pullSyncId, afterSyncId] contains only our own events, so there is
      // nothing to pull up to afterSyncId — advancing skips the redundant empty pull
      // triggered by the remote's post-apply broadcast.
      if (
        response.ok &&
        response.beforeSyncId !== undefined &&
        response.afterSyncId !== undefined &&
        response.beforeSyncId <= pullSyncId.current &&
        response.afterSyncId > pullSyncId.current
      ) {
        pullSyncId.current = response.afterSyncId;
      }
      if (!eventsBatch.hasMore) {
        break;
      }
    }
  });

  const onEventsApplied = () => {
    startPushingEvents();
  };
  storage.addEventListener("events-applied", onEventsApplied);

  const getState = (): "pending" | "offline" | "online" => remoteState.type;

  const dispose = async () => {
    await goOffline("DISCONNECTED");
    storage.removeEventListener("events-applied", onEventsApplied);
  };

  return {
    goOnline,
    goOffline,
    syncWithRemote,
    getState,
    dispose,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
};
