import retryAsPromised from "retry-as-promised";
import { createTypedEventTarget, ensureSingletonExecution, tryCatchAsync } from "../utils";
import type { EventsPullResponse } from "../worker-db/worker-common";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage } from "./crdt-storage";
import type { StoredValue } from "./stored-value";

type CrdtSyncRemoteSourceConfig = {
  bufferSize: number;
  storage: CrdtStorage;
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
  events: PendingCrdtEvent[];
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
    }
  | {
      type: "online";
      source: RemoteSource;
    };

export const createCrdtSyncRemoteSource = ({
  bufferSize,
  storage,
  pullSyncId,
  pushSyncId,
  nodeId,
  remoteFactory,
}: CrdtSyncRemoteSourceConfig) => {
  const eventTarget = createTypedEventTarget<{
    "state-changed": RemoteSourceState["type"];
  }>();

  let remoteState: RemoteSourceState = { type: "offline" };

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
        throw new Error("Remote source factory not provided");
      }

      setRemoteState({ type: "pending" });

      const factoryResult = await tryCatchAsync(async () => {
        return await remoteFactory?.({
          onEventsAvailable: () => {
            pullEvents({ includeSelf: false });
          },
        });
      });

      if (!factoryResult.success) {
        setRemoteState({ type: "offline" });
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
    async () => {
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

      setRemoteState({ type: "offline" });
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
        goOffline();
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
        storage.enqueueEvents(
          response.events.map((x) => ({
            ...x,
            origin: "remote",
          })),
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

      try {
        await retryAsPromised(
          () =>
            source.pushEvents({
              nodeId,
              events: eventsBatch.events,
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
        goOffline();
        return;
      }

      pushSyncId.current = eventsBatch.nextSyncId;
      pendingEventsCount = Math.max(0, pendingEventsCount - eventsBatch.events.length);
      if (!eventsBatch.hasMore) {
        break;
      }
    }
  });

  let pendingEventsCount = 0;
  storage.addEventListener("event-applied", (event) => {
    if (event.payload.origin === "remote") {
      return;
    }
    pendingEventsCount++;
    if (pendingEventsCount >= bufferSize) {
      startPushingEvents();
    }
  });

  storage.addEventListener("event-processing-done", () => {
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
