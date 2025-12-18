import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import type { CrdtEventOrigin, CrdtEventStatus, CrdtEventType, PersistedCrdtEvent } from "./crdt-table-schema";
import type { SyncIdCounter } from "./sync-id-counter";

type LocalCrdtEvent = {
  type: CrdtEventType;
  timestamp: string;
  dataset: string;
  item_id: string;
  payload: string;
  origin: CrdtEventOrigin;
};

export type GetEventsOptions = {
  afterSyncId?: number;
  status?: CrdtEventStatus;
  excludeOrigin?: string;
  limit?: number;
};

export type GetEventsBatch = {
  events: PersistedCrdtEvent[];
  hasMore: boolean;
  nextSyncId: number;
};

type DbSyncerStorage = {
  syncId: SyncIdCounter;
  persistEvents: (events: PersistedCrdtEvent[]) => void;
  getEventsBatch: (options: GetEventsOptions) => PersistedCrdtEvent[];
  updateEventStatus: (syncId: number, status: CrdtEventStatus) => void;
  applyCrdtEventMutations: (event: PersistedCrdtEvent) => void;
};

export type CrdtStorage = ReturnType<typeof createCrdtStorage>;

export function createCrdtStorage(storage: DbSyncerStorage) {
  const eventTarget = createTypedEventTarget<{
    "event-applied": PersistedCrdtEvent;
    "event-processing-done": undefined;
  }>();

  const enqueueEvents = (events: LocalCrdtEvent[]) => {
    const firstEventSyncId = storage.syncId.current + 1;
    storage.persistEvents(
      events.map((x) => ({
        timestamp: x.timestamp,
        type: x.type,
        dataset: x.dataset,
        item_id: x.item_id,
        origin: x.origin,
        payload: x.payload,
        sync_id: ++storage.syncId.current,
        status: "pending",
      })),
    );
    const lastEventSyncId = storage.syncId.current;

    processEnqueuedEvents();

    return {
      firstEventSyncId,
      lastEventSyncId,
    };
  };

  const getEventsBatch = (options: GetEventsOptions): GetEventsBatch => {
    const events = storage.getEventsBatch({
      ...options,
      limit: options.limit ?? 50,
    });
    return {
      events,
      hasMore: events.length === options.limit,
      nextSyncId: events[events.length - 1]?.sync_id ?? options.afterSyncId ?? 0,
    };
  };

  const processEnqueuedEvents = ensureSingletonExecution(async () => {
    await Promise.resolve();

    let hasMore = true;
    while (hasMore) {
      const batch = getEventsBatch({ status: "pending", limit: 50 });
      const events = batch.events;
      hasMore = batch.hasMore;

      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        try {
          storage.applyCrdtEventMutations(event);
          event.status = "applied";
        } catch (error) {
          console.error("Error applying enqueued CRDT event", error);
          event.status = "failed";
        } finally {
          storage.updateEventStatus(event.sync_id, event.status);
          eventTarget.dispatchEvent("event-applied", event);
        }
      }
    }
    eventTarget.dispatchEvent("event-processing-done", undefined);
  });

  return {
    enqueueEvents,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
    dispatchEvent: eventTarget.dispatchEvent,
    getEventsBatch,
  };
}
