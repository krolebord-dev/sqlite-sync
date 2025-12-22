import retryAsPromised from "retry-as-promised";
import { ensureSingletonExecution } from "../utils";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage, GetEventsBatch } from "./crdt-storage";
import type { SyncIdCounter } from "./sync-id-counter";

type CrdtSyncRemoteSourceConfig = {
  bufferSize: number;
  storage: CrdtStorage;
  pullSyncId: SyncIdCounter;
  pushSyncId: SyncIdCounter;
  nodeId: string;
  pullEvents: (request: EventsPullRequest) => GetEventsBatch | Promise<GetEventsBatch>;
  pushEvents: (request: EventsPushRequest) => EventsPushResponse | Promise<EventsPushResponse>;
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

export const createCrdtSyncRemoteSource = ({
  bufferSize,
  storage,
  pullSyncId,
  pushSyncId,
  nodeId,
  pullEvents: pullEventsChunk,
  pushEvents,
}: CrdtSyncRemoteSourceConfig) => {
  let requestedPullSyncId: number | null = null;
  let pullPromise: Promise<void> | null = null;
  const pullEvents = (request?: { afterSyncId?: number; includeSelf?: boolean }) => {
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
    }).finally(() => {
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
      const response = await retryAsPromised(
        () =>
          pullEventsChunk({
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

      await retryAsPromised(
        () =>
          pushEvents({
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

      pushSyncId.current = eventsBatch.nextSyncId;
      pendingEventsCount -= eventsBatch.events.length;
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

  return {
    pullEvents,
  };
};
