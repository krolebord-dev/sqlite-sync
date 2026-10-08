import type { SyncDbMigrator } from "../migrations/migrator";
import { createTypedEventTarget, ensureSingletonExecution, tryCatchAsync } from "../utils";
import type { EventsPullResponse, WorkerState } from "../worker-db/worker-common";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage } from "./crdt-storage";
import { REMOTE_RETRY_OPTIONS, retryRemoteOperation } from "./retry-remote-operation";
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

const DISCONNECT_WATCHDOG_MS = 15_000;

export type CrdtSyncRemoteSource = ReturnType<typeof createCrdtSyncRemoteSource>;

export type EventsAvailable = {
  newSyncId: number;
  remoteEventHlcSum: string | null;
};

/**
 * Opens a connection to the remote. Each call must return an independent source: the library calls
 * `disconnect` on every returned source exactly once, including one that resolves after `signal`
 * has aborted. `signal` aborts when the connection attempt is cancelled or the connection is closed.
 */
export type CreateRemoteSourceFactory = (opts: {
  onEventsAvailable: (event: EventsAvailable) => void;
  signal: AbortSignal;
}) => RemoteSource | Promise<RemoteSource>;

type RemoteSource = {
  pullEvents: (request: EventsPullRequest) => Promise<EventsPullResponse>;
  pushEvents: (request: EventsPushRequest) => Promise<EventsPushResponse>;
  disconnect?: () => void | Promise<void>;
};

export class SchemaVersionMismatchError extends Error {
  constructor(
    public remoteSchemaVersion: number,
    public localSchemaVersion: number,
  ) {
    super(`Schema version mismatch: remote ${remoteSchemaVersion} != local ${localSchemaVersion}`);
    this.name = "SchemaVersionMismatchError";
  }
}

type RemoteSourceState =
  | {
      type: "pending";
      deSynced: boolean;
      schemaVersionMismatched: boolean;
    }
  | {
      type: "offline";
      reason: OfflineReason;
      deSynced: boolean;
      schemaVersionMismatched: boolean;
    }
  | {
      type: "online";
      deSynced: boolean;
      schemaVersionMismatched: boolean;
    };

export type OfflineReason =
  | "NOT_INITIALIZED"
  | "INITIALIZATION_FAILED"
  | "REMOTE_PUSH_ERROR"
  | "REMOTE_PULL_ERROR"
  | "DISCONNECTED";

export type DeSyncDetectedReason = "CHECKSUM_MISMATCH" | "ERROR_APPLYING_REMOTE_EVENT";

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
    "de-sync-detected": {
      reason: DeSyncDetectedReason;
    };
    "remote-schema-version-mismatch": {
      remoteSchemaVersion: number;
      localSchemaVersion: number;
    };
  }>();

  let remoteState: RemoteSourceState = {
    type: "offline",
    reason: "NOT_INITIALIZED",
    deSynced: false,
    schemaVersionMismatched: false,
  };

  const patchRemoteState = (state: Partial<RemoteSourceState>) => {
    remoteState = { ...remoteState, ...state } as RemoteSourceState;
    eventTarget.dispatchEvent("state-changed", remoteState.type);
  };

  let current: Connection | null = null;
  let disposed = false;

  const disconnectSource = (source: RemoteSource) => {
    const watchdog = setTimeout(() => {
      console.error(`Remote source did not disconnect within ${DISCONNECT_WATCHDOG_MS}ms`);
    }, DISCONNECT_WATCHDOG_MS);
    void tryCatchAsync(async () => await source.disconnect?.()).then((result) => {
      clearTimeout(watchdog);
      if (!result.success) {
        console.warn("Error while disconnecting from remote source", result.error);
      }
    });
  };

  const closeConnection = (connection: Connection, reason: OfflineReason) => {
    if (current !== connection) {
      return;
    }
    current = null;
    connection.close();
    patchRemoteState({ type: "offline", reason });
  };

  type Connection = ReturnType<typeof createConnection>;
  const createConnection = (factory: CreateRemoteSourceFactory) => {
    const controller = new AbortController();
    const { signal } = controller;
    let source: RemoteSource | null = null;

    const untilClosed = <T>(operation: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("Remote connection closed"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        operation()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });

    const retryOptions = { ...REMOTE_RETRY_OPTIONS, shouldRetry: () => !signal.aborted };

    const connect = async () => {
      if (signal.aborted) {
        return;
      }

      const result = await tryCatchAsync(
        async () =>
          await factory({
            onEventsAvailable: ({ newSyncId, remoteEventHlcSum }) => {
              pull({ remoteSyncId: newSyncId, remoteEventHlcSum, includeSelf: false });
            },
            signal,
          }),
      );

      if (signal.aborted) {
        if (result.success) {
          disconnectSource(result.data);
        }
        return;
      }

      if (!result.success) {
        console.warn("Failed to create remote source", result.error);
        closeConnection(connection, "INITIALIZATION_FAILED");
        return;
      }

      source = result.data;
      patchRemoteState({ type: "online", deSynced: false, schemaVersionMismatched: false });
      void sync();
    };

    type ActivePull = { promise: Promise<void>; requestedSyncId: number | null };
    let activePull: ActivePull | null = null;
    const pull = (request?: {
      remoteSyncId?: number;
      remoteEventHlcSum?: string | null;
      includeSelf?: boolean;
    }): Promise<void> => {
      if (!source || signal.aborted) {
        return Promise.resolve();
      }
      const activeSource = source;

      const remoteSyncId = request?.remoteSyncId;

      if (remoteSyncId !== undefined && remoteSyncId <= pullSyncId.current) {
        // We are already caught up to this broadcast, so there is nothing to pull.
        // This is the quiescent moment to verify we have not diverged from the
        // remote (the check is a no-op unless we are exactly aligned: remoteSyncId
        // === pullSyncId.current).
        checkRemoteConsistency(remoteSyncId, request?.remoteEventHlcSum ?? null);
        return Promise.resolve();
      }

      if (activePull) {
        if (remoteSyncId !== undefined && (!activePull.requestedSyncId || activePull.requestedSyncId < remoteSyncId)) {
          activePull.requestedSyncId = remoteSyncId;
        }
        return activePull.promise;
      }

      const nextPull: ActivePull = { promise: Promise.resolve(), requestedSyncId: null };
      nextPull.promise = pullAllEvents(activeSource, {
        afterSyncId: pullSyncId.current,
        excludeNodeId: request?.includeSelf ? undefined : nodeId,
      })
        .catch((error) => {
          if (signal.aborted) {
            return;
          }
          console.error("Error pulling events. Going offline.", error);
          closeConnection(connection, "REMOTE_PULL_ERROR");
        })
        .finally(() => {
          if (activePull === nextPull) {
            activePull = null;
          }

          const nextTarget = nextPull.requestedSyncId;
          if (nextTarget && nextTarget > pullSyncId.current) {
            pull({ remoteSyncId: nextTarget });
          }
        });
      activePull = nextPull;
      return nextPull.promise;
    };

    const pullAllEvents = async (activeSource: RemoteSource, opts: EventsPullRequest) => {
      let hasMore = true;
      let afterSyncId = opts.afterSyncId;
      while (hasMore) {
        const response = await retryRemoteOperation(
          () =>
            untilClosed(() =>
              activeSource.pullEvents({
                ...opts,
                afterSyncId,
              }),
            ),
          retryOptions,
        );
        if (signal.aborted) {
          return;
        }
        hasMore = response.hasMore;
        afterSyncId = response.nextSyncId;

        if (response.events) {
          storage.enqueueRemoteEvents(
            response.events.map((x) => {
              if (x.schema_version > migrator.currentSchemaVersion) {
                eventTarget.dispatchEvent("remote-schema-version-mismatch", {
                  remoteSchemaVersion: x.schema_version,
                  localSchemaVersion: migrator.currentSchemaVersion,
                });
                if (remoteState.type === "online" && !remoteState.schemaVersionMismatched) {
                  patchRemoteState({ schemaVersionMismatched: true });
                }
                throw new SchemaVersionMismatchError(x.schema_version, migrator.currentSchemaVersion);
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

    const push = ensureSingletonExecution(async () => {
      while (source && !signal.aborted) {
        const activeSource = source;
        const eventsBatch = storage.getEventsBatch({
          status: "applied",
          afterSyncId: pushSyncId.current,
          excludeOrigin: "remote",
          limit: bufferSize,
        });
        if (eventsBatch.events.length === 0) {
          break;
        }

        let response: EventsPushResponse;
        try {
          response = await retryRemoteOperation(
            () =>
              untilClosed(() =>
                activeSource.pushEvents({
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
              ),
            retryOptions,
          );
        } catch (error) {
          if (!signal.aborted) {
            console.error("Error pushing events. Going offline.", error);
            closeConnection(connection, "REMOTE_PUSH_ERROR");
          }
          return;
        }

        if (signal.aborted) {
          return;
        }

        if (!response.ok) {
          console.error("Remote rejected pushed events. Going offline.");
          closeConnection(connection, "REMOTE_PUSH_ERROR");
          return;
        }

        pushSyncId.current = eventsBatch.nextSyncId;

        // Fast-forward the pull cursor: the remote assigns sync ids for the pushed
        // events synchronously, so (beforeSyncId, afterSyncId] contains only this
        // node's own events. If we are caught up to at least beforeSyncId, the skipped
        // range (pullSyncId, afterSyncId] contains only our own events, so there is
        // nothing to pull up to afterSyncId.
        if (
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

    const sync = async () => {
      await pull();
      await push();
    };

    const close = () => {
      controller.abort();
      if (source) {
        disconnectSource(source);
      }
    };

    const ready = Promise.resolve()
      .then(() => untilClosed(connect))
      .catch((error) => {
        if (!signal.aborted) {
          throw error;
        }
      });

    const connection = { ready, close, push, sync };
    return connection;
  };

  const goOnline = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (current) {
      return current.ready;
    }
    if (!remoteFactory) {
      console.warn("Remote source factory not provided. Going offline.");
      patchRemoteState({ type: "offline", reason: "NOT_INITIALIZED" });
      return Promise.resolve();
    }

    const connection = createConnection(remoteFactory);
    current = connection;
    patchRemoteState({ type: "pending" });
    return connection.ready;
  };

  const goOffline = async (reason: OfflineReason) => {
    if (current) {
      closeConnection(current, reason);
    }
  };

  const syncWithRemote = async () => {
    await current?.sync();
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

    if (localEventHlcSum === remoteEventHlcSum) {
      // No de-sync detected.
      return;
    }

    eventTarget.dispatchEvent("de-sync-detected", { reason: "CHECKSUM_MISMATCH" });
    console.warn(
      `[sqlite-sync] De-sync detected at syncId ${remoteSyncId}: local HLC checksum ${localEventHlcSum} != remote ${remoteEventHlcSum}. Local and remote have diverged despite being caught up.`,
    );
    if (remoteState.type === "online" && !remoteState.deSynced) {
      patchRemoteState({ deSynced: true });
    }
  };

  const eventsAppliedSubscription = storage.addEventListener("events-applied", () => {
    current?.push();
  });

  const remoteEventApplyFailedSubscription = storage.addEventListener("remote-event-apply-failed", () => {
    eventTarget.dispatchEvent("de-sync-detected", { reason: "ERROR_APPLYING_REMOTE_EVENT" });
    if (remoteState.type === "online" && !remoteState.deSynced) {
      patchRemoteState({ deSynced: true });
    }
  });

  const getState = (): WorkerState => ({
    remoteState: remoteState.type,
    deSynced: remoteState.deSynced,
    schemaVersionMismatched: remoteState.schemaVersionMismatched,
  });

  const dispose = async () => {
    disposed = true;
    eventsAppliedSubscription.unsubscribe();
    remoteEventApplyFailedSubscription.unsubscribe();
    await goOffline("DISCONNECTED");
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
