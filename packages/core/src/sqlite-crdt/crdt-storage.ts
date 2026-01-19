import type { SyncDbMigrator } from "../migrations/migrator";
import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import type { CrdtEventOrigin, CrdtEventStatus, CrdtEventType, PersistedCrdtEvent } from "./crdt-table-schema";
import type { StoredValue } from "./stored-value";

type LocalCrdtEvent = {
  schema_version: number;
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

export type EventUpdate = {
  status: CrdtEventStatus;
  schema_version: number;
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
};

type DbSyncerStorage = {
  syncId: StoredValue<number>;
  migrator: SyncDbMigrator;
  persistEvents: (events: PersistedCrdtEvent[]) => void;
  getEventsBatch: (options: GetEventsOptions) => PersistedCrdtEvent[];
  updateEvent: (syncId: number, update: EventUpdate) => void;
  handleCrdtEventApply: (event: PersistedCrdtEvent) => void;
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
        schema_version: x.schema_version,
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
        // Migrate event to latest schema version
        const migratedEvent = storage.migrator.migrateEvent(event, storage.migrator.latestSchemaVersion);

        if (migratedEvent === null) {
          // Event was dropped during migration (e.g., table was deleted)
          event.status = "skipped";
          storage.updateEvent(event.sync_id, {
            status: event.status,
            schema_version: storage.migrator.latestSchemaVersion,
            type: event.type,
            dataset: event.dataset,
            item_id: event.item_id,
            payload: event.payload,
          });
          continue;
        }

        // Update event with migrated values
        event.schema_version = migratedEvent.schema_version;
        event.type = migratedEvent.type;
        event.dataset = migratedEvent.dataset;
        event.item_id = migratedEvent.item_id;
        event.payload = migratedEvent.payload;

        try {
          storage.handleCrdtEventApply(event);
          event.status = "applied";
        } catch (error) {
          console.error("Error applying enqueued CRDT event", error);
          event.status = "failed";
        } finally {
          storage.updateEvent(event.sync_id, {
            status: event.status,
            schema_version: event.schema_version,
            type: event.type,
            dataset: event.dataset,
            item_id: event.item_id,
            payload: event.payload,
          });
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
