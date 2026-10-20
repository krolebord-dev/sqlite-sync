import type { SyncDbMigrator } from "../migrations/migrator";
import { createDeferredPromise, createTypedEventTarget, ensureSingletonExecution, tryCatchAsync } from "../utils";
import type { EventsPullResponse, WorkerState } from "../worker-db/worker-common";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage } from "./crdt-storage";
import { parseStateHash } from "./state-hash";
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

export const PUSH_BATCH_SIZE = 75;
export const MAX_PUSH_EVENTS = 100;

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
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Backoff restarts only after a connection stays up this long, so a remote that accepts and then drops
// connections right away is not hammered.
const RECONNECT_MIN_UPTIME_MS = 5_000;
// Pings a remote that has sent nothing for this long, to catch connections that died without closing.
const HEARTBEAT_IDLE_MS = 25_000;

export type CrdtSyncRemoteSource = ReturnType<typeof createCrdtSyncRemoteSource>;

export type EventsAvailable = {
  newSyncId: number;
  remoteStateHash: string | null;
};

/**
 * Opens one connection to the remote. Each call must return a new source: the library calls `disconnect` on every
 * returned source exactly once. Call `onClosed` when the connection ends on its own, at any time including during
 * this call; the library then reconnects with backoff. Requests may wait for the connection to open and should
 * reject once it closes. The library times requests out and shows the remote as online after the first one succeeds.
 * With `ping`, the library also checks idle connections and replaces one whose ping fails or times out. It calls `ping`
 * only on an online connection, one at a time, and never after the connection closes; a ping does not need to settle
 * once the source has closed.
 */
export type CreateRemoteSourceFactory = (opts: {
  onEventsAvailable: (event: EventsAvailable) => void;
  onClosed: (error?: unknown) => void;
}) => RemoteSource;

type RemoteSource = {
  pullEvents: (request: EventsPullRequest) => Promise<EventsPullResponse>;
  pushEvents: (request: EventsPushRequest) => Promise<EventsPushResponse>;
  ping?: () => Promise<void>;
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
      type: "connecting";
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
  | "CONNECTION_LOST"
  | "NETWORK_OFFLINE"
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
    const previous = remoteState;
    remoteState = { ...remoteState, ...state } as RemoteSourceState;
    if (
      remoteState.type !== previous.type ||
      remoteState.deSynced !== previous.deSynced ||
      remoteState.schemaVersionMismatched !== previous.schemaVersionMismatched
    ) {
      eventTarget.dispatchEvent("state-changed", remoteState.type);
    }
  };

  let current: Connection | null = null;
  let disposed = false;
  let wantsOnline = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;

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

  const closeConnection = (connection: Connection, reason: OfflineReason, { reconnect = false } = {}) => {
    if (current !== connection) {
      return false;
    }
    current = null;
    if (reconnect && scheduleReconnect()) {
      patchRemoteState({ type: "connecting" });
    } else {
      patchRemoteState({ type: "offline", reason });
    }
    connection.close();
    return true;
  };

  const cancelReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  // Retrying after a schema mismatch would fail the same way.
  const scheduleReconnect = () => {
    if (!wantsOnline || current || reconnectTimer || remoteState.schemaVersionMismatched) {
      return false;
    }
    const maxDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt);
    reconnectAttempt++;
    const delay = maxDelay / 2 + (Math.random() * maxDelay) / 2;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
    return true;
  };

  type Connection = ReturnType<typeof createConnection>;
  const createConnection = (factory: CreateRemoteSourceFactory) => {
    const controller = new AbortController();
    const { signal } = controller;
    const ready = createDeferredPromise<void>();
    let source: RemoteSource | null = null;
    let establishedAt: number | null = null;
    let lastActivityAt = Date.now();
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

    const untilClosed = <T>(operation: () => Promise<T>, timeoutMs?: number) =>
      new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("Remote connection closed"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        const timeout =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => reject(new Error(`Remote request timed out after ${timeoutMs}ms`)), timeoutMs);
        operation()
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
          });
      });

    const request = async <T>(operation: () => Promise<T>) => {
      const response = await untilClosed(operation, REQUEST_TIMEOUT_MS);
      lastActivityAt = Date.now();
      if (establishedAt === null && !signal.aborted) {
        establishedAt = Date.now();
        patchRemoteState({ type: "online", schemaVersionMismatched: false });
        ready.resolve();
        scheduleHeartbeat();
      }
      return response;
    };

    const fail = (reason: OfflineReason, { reconnect = true } = {}) => {
      if (current !== connection) {
        return;
      }
      if (establishedAt !== null && Date.now() - establishedAt >= RECONNECT_MIN_UPTIME_MS) {
        reconnectAttempt = 0;
      }
      closeConnection(connection, establishedAt === null ? "INITIALIZATION_FAILED" : reason, { reconnect });
    };

    // A close during the factory call aborts before `source` is set, so the abort check below disconnects it.
    const start = () => {
      if (signal.aborted) {
        return;
      }

      let created: RemoteSource;
      try {
        created = factory({
          onEventsAvailable: ({ newSyncId, remoteStateHash }) => {
            lastActivityAt = Date.now();
            pull({ remoteSyncId: newSyncId, remoteStateHash, includeSelf: false });
          },
          onClosed: (error) => {
            if (signal.aborted) {
              return;
            }
            if (error !== undefined) {
              console.warn("Remote connection closed", error);
            }
            fail("CONNECTION_LOST");
          },
        });
      } catch (error) {
        console.warn("Failed to create remote source", error);
        fail("INITIALIZATION_FAILED");
        return;
      }

      if (signal.aborted) {
        disconnectSource(created);
        return;
      }
      source = created;
      void sync();
    };

    const scheduleHeartbeat = () => {
      const ping = source?.ping?.bind(source);
      if (!ping || signal.aborted) {
        return;
      }
      heartbeatTimer = setTimeout(
        async () => {
          if (Date.now() - lastActivityAt >= HEARTBEAT_IDLE_MS) {
            try {
              await request(ping);
            } catch (error) {
              if (!signal.aborted) {
                console.warn("Remote did not answer a ping", error);
                fail("CONNECTION_LOST");
              }
              return;
            }
          }
          scheduleHeartbeat();
        },
        Math.max(0, lastActivityAt + HEARTBEAT_IDLE_MS - Date.now()),
      );
    };

    type ActivePull = { promise: Promise<void>; requestedSyncId: number | null };
    let activePull: ActivePull | null = null;
    const pull = (request?: {
      remoteSyncId?: number;
      remoteStateHash?: string | null;
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
        checkRemoteConsistency(remoteSyncId, request?.remoteStateHash ?? null);
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
          fail("REMOTE_PULL_ERROR");
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
        const response = await request(() =>
          activeSource.pullEvents({
            ...opts,
            afterSyncId,
          }),
        );
        if (signal.aborted) {
          return;
        }
        hasMore = response.hasMore;
        afterSyncId = response.nextSyncId;

        if (response.events) {
          const { processed } = storage.enqueueRemoteEvents(
            response.events.map((x) => {
              if (x.schema_version > migrator.currentSchemaVersion) {
                eventTarget.dispatchEvent("remote-schema-version-mismatch", {
                  remoteSchemaVersion: x.schema_version,
                  localSchemaVersion: migrator.currentSchemaVersion,
                });
                if (!remoteState.schemaVersionMismatched) {
                  patchRemoteState({ schemaVersionMismatched: true });
                }
                throw new SchemaVersionMismatchError(x.schema_version, migrator.currentSchemaVersion);
              }
              return x;
            }),
          );
          await untilClosed(() => processed);
          if (signal.aborted) {
            return;
          }
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
          response = await request(() =>
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
          );
        } catch (error) {
          if (!signal.aborted) {
            console.error("Error pushing events. Going offline.", error);
            fail("REMOTE_PUSH_ERROR");
          }
          return;
        }

        if (signal.aborted) {
          return;
        }

        if (!response.ok) {
          // The remote would reject the same batch again, so only an explicit sync retries it.
          console.error("Remote rejected pushed events. Going offline.");
          fail("REMOTE_PUSH_ERROR", { reconnect: false });
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

    // Waits out in-flight operations first: they may have started before the caller's request.
    const sync = async () => {
      await activePull?.promise;
      await pull();
      await push.promise();
      await push();
    };

    const close = () => {
      controller.abort();
      clearTimeout(heartbeatTimer);
      ready.resolve();
      if (source) {
        disconnectSource(source);
      }
    };

    const connection = { ready: ready.promise, start, close, push, sync };
    return connection;
  };

  const connect = (): Promise<void> => {
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

    cancelReconnect();
    wantsOnline = true;
    const connection = createConnection(remoteFactory);
    current = connection;
    patchRemoteState({ type: "connecting" });
    connection.start();
    return connection.ready;
  };

  const goOnline = () => {
    reconnectAttempt = 0;
    return connect();
  };

  // Unlike goOffline, leaves syncWithRemote free to reconnect, but does not retry on its own: the caller
  // knows the network is gone and calls syncWithRemote once it is back.
  const dropConnection = (reason: OfflineReason) => {
    cancelReconnect();
    if (current) {
      closeConnection(current, reason);
    } else if (remoteState.type === "connecting") {
      patchRemoteState({ type: "offline", reason });
    }
  };

  const goOffline = async (reason: OfflineReason) => {
    wantsOnline = false;
    dropConnection(reason);
  };

  // Reconnects right away, skipping any backoff, unless goOffline or a schema mismatch took us offline.
  const syncWithRemote = async () => {
    if (current) {
      await current.sync();
    } else if (wantsOnline && !remoteState.schemaVersionMismatched) {
      await goOnline();
    }
  };

  // De-sync detection: when we are exactly caught up to the remote's broadcast
  // sync id and fully quiescent, we hold the same events as the remote, so our
  // materialized CRDT state and its hash must match. A mismatch means the nodes
  // have diverged.
  const checkRemoteConsistency = (remoteSyncId: number, remoteStateHash: string | null) => {
    // A remote that does not report a state hash gives us nothing to compare against.
    if (remoteStateHash == null) {
      return;
    }

    // Only meaningful when we are exactly caught up: if we are behind we still
    // need to pull; if we are ahead our state covers events the remote hash
    // does not.
    if (remoteSyncId !== pullSyncId.current) {
      return;
    }

    // Quiescence: the hashes only match when nothing is left to apply locally and
    // no local applied events are still waiting to be pushed (those are in our
    // state but the remote has not seen them yet).
    if (!storage.checkIsQuiescent(pushSyncId.current)) {
      return;
    }

    const localStateHash = storage.getStateHash();
    if (localStateHash === null || localStateHash === remoteStateHash) {
      return;
    }

    // Hashes for different schema versions cover different columns, e.g. while
    // the remote has been migrated by a deploy that this client has not loaded yet.
    const local = parseStateHash(localStateHash);
    const remote = parseStateHash(remoteStateHash);
    if (!local || !remote || local.schemaVersion !== remote.schemaVersion) {
      return;
    }

    eventTarget.dispatchEvent("de-sync-detected", { reason: "CHECKSUM_MISMATCH" });
    console.warn(
      `[sqlite-sync] De-sync detected at syncId ${remoteSyncId}: local state hash ${localStateHash} != remote ${remoteStateHash}. Local and remote have diverged despite being caught up.`,
    );
    if (!remoteState.deSynced) {
      patchRemoteState({ deSynced: true });
    }
  };

  const eventsAppliedSubscription = storage.addEventListener("events-applied", () => {
    current?.push();
  });

  const remoteEventApplyFailedSubscription = storage.addEventListener("remote-event-apply-failed", () => {
    eventTarget.dispatchEvent("de-sync-detected", { reason: "ERROR_APPLYING_REMOTE_EVENT" });
    if (!remoteState.deSynced) {
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
    dropConnection,
    syncWithRemote,
    getState,
    dispose,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
};
