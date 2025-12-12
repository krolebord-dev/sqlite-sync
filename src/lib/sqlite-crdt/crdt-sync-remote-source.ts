import { createAsyncAutoFlushBuffer } from "../utils";
import type { PendingCrdtEvent } from "./apply-crdt-event";
import type { CrdtStorage } from "./crdt-storage";
import type { PersistedCrdtEvent } from "./crdt-table-schema";
import type { SyncIdCounter } from "./sync-id-counter";

type CrdtSyncRemoteSourceConfig = {
  bufferSize: number;
  storage: CrdtStorage;
  syncId: SyncIdCounter;
  nodeId: string;
  pullEvents: (
    request: EventsPullRequest
  ) => EventsPullResponse | Promise<EventsPullResponse>;
  pushEvents: (
    request: EventsPushRequest
  ) => EventsPushResponse | Promise<EventsPushResponse>;
};

export type EventsPullRequest = {
  afterSyncId: number;
  excludeNodeId?: string;
};
export type EventsPullResponse = {
  events: PersistedCrdtEvent[];
  newSyncId: number;
  hasMore: boolean;
};

export type EventsPushRequest = {
  nodeId: string;
  events: PendingCrdtEvent[];
};
export type EventsPushResponse = {
  ok: boolean;
};

export type CrdtSyncRemoteSource = ReturnType<
  typeof createCrdtSyncRemoteSource
>;

export const createCrdtSyncRemoteSource = ({
  bufferSize,
  storage,
  syncId,
  nodeId,
  pullEvents: pullEventsChunk,
  pushEvents,
}: CrdtSyncRemoteSourceConfig) => {
  let pullPromise: Promise<void> | null = null;
  let requestedPullSyncId: number | null = null;

  const pullEvents = (request?: {
    afterSyncId?: number;
    includeSelf?: boolean;
  }) => {
    const afterSyncId = request?.afterSyncId ?? syncId.current;

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

      if (requestedPullSyncId && requestedPullSyncId > syncId.current) {
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
      const response = await pullEventsChunk({
        ...opts,
        afterSyncId,
      });
      hasMore = response.hasMore;
      afterSyncId = response.newSyncId;

      if (response.events) {
        storage.enqueueEvents(
          response.events.map((x) => ({
            ...x,
            origin: "remote",
          }))
        );
      }
      if (response.newSyncId <= syncId.current) {
        break;
      }
      if (response.newSyncId > syncId.current) {
        syncId.current = response.newSyncId;
      }
    }
  };

  const pushEventsBuffer = createAsyncAutoFlushBuffer<PendingCrdtEvent>({
    size: bufferSize,
    flush: async (events) => {
      await pushEvents({ nodeId, events });
    },
  });

  storage.addEventListener("event-applied", (event) => {
    if (event.payload.origin === "remote") {
      return;
    }
    pushEventsBuffer.add(event.payload);
  });

  storage.addEventListener("event-processing-done", () => {
    pushEventsBuffer.flush();
  });

  return {
    pullEvents,
  };
};
