import { deserializeHLC, type HLCCounter, serializeHLC } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import type { CrdtEventOrigin, CrdtEventStatus, CrdtEventType, PersistedCrdtEvent } from "./crdt-table-schema";
import type { StoredValue } from "./stored-value";

type LocalCrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
  timestamp: string;
  schema_version: number;
};

export type OwnCrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
  timestamp?: undefined;
  schema_version?: undefined;
};

type RemoteCrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
  timestamp: string;
  schema_version: number;
};

type EnqueuedCrdtEvent = LocalCrdtEvent | OwnCrdtEvent | RemoteCrdtEvent;

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

type StorageHLC = Pick<HLCCounter, "getNextHLC" | "mergeHLC">;

type DbSyncerStorage = {
  syncId: StoredValue<number>;
  migrator: SyncDbMigrator;
  persistEvent: (events: PersistedCrdtEvent) => void;
  getEventsBatch: (options: GetEventsOptions) => PersistedCrdtEvent[];
  updateEvent: (syncId: number, update: EventUpdate) => void;
  handleCrdtEventApply: (event: PersistedCrdtEvent) => void;
  hlc: StorageHLC;
  transaction?: (callback: () => void) => void;
};

export type CrdtStorage = ReturnType<typeof createCrdtStorage>;

export const crdtEventOrigin = {
  local: "local",
  own: "own",
  remote: "remote",
};

type EventsAppliedPayload = {
  syncId: number;
};

export function createCrdtStorage(storage: DbSyncerStorage) {
  const transaction = storage.transaction ?? ((callback) => callback());
  const eventTarget = createTypedEventTarget<{
    "events-applied": EventsAppliedPayload;
  }>();

  const enqueueEvents = (origin: CrdtEventOrigin, events: EnqueuedCrdtEvent[]) => {
    if (events.length === 0) {
      return;
    }

    transaction(() => {
      for (const event of events) {
        storage.persistEvent({
          schema_version: event.schema_version ?? storage.migrator.currentSchemaVersion,
          timestamp: event.timestamp ?? serializeHLC(storage.hlc.getNextHLC()),
          type: event.type,
          dataset: event.dataset,
          item_id: event.item_id,
          origin: origin,
          payload: event.payload,
          sync_id: ++storage.syncId.current,
          status: "pending",
        });
      }
    });

    processEnqueuedEvents();
  };

  const enqueueLocalEvents = (events: LocalCrdtEvent[]) => {
    enqueueEvents("local", events);
  };

  const enqueueOwnEvents = (events: OwnCrdtEvent[]) => {
    enqueueEvents("own", events);
  };

  const enqueueRemoteEvents = (events: RemoteCrdtEvent[]) => {
    enqueueEvents("remote", events);
  };

  const applyOwnEvent = (event: OwnCrdtEvent, { wrapInTransaction }: { wrapInTransaction?: boolean } = {}) => {
    const persistedEvent: PersistedCrdtEvent = {
      schema_version: storage.migrator.currentSchemaVersion,
      timestamp: serializeHLC(storage.hlc.getNextHLC()),
      type: event.type,
      dataset: event.dataset,
      item_id: event.item_id,
      origin: "own",
      payload: event.payload,
      sync_id: ++storage.syncId.current,
      status: "pending",
    };

    if (wrapInTransaction) {
      transaction(() => {
        storage.persistEvent(persistedEvent);
        processPersistedEvent(persistedEvent);
      });
    } else {
      storage.persistEvent(persistedEvent);
      processPersistedEvent(persistedEvent);
    }
  };

  const dispatchEventsApplied = () => {
    eventTarget.dispatchEvent("events-applied", {
      syncId: storage.syncId.current,
    });
  };

  const getEventsBatch = (options: GetEventsOptions): GetEventsBatch => {
    const limit = options.limit ?? 50;
    const events = storage.getEventsBatch({
      ...options,
      limit,
    });
    return {
      events,
      hasMore: events.length === limit,
      nextSyncId: events[events.length - 1]?.sync_id ?? options.afterSyncId ?? 0,
    };
  };

  const processPersistedEvent = (event: PersistedCrdtEvent) => {
    if (event.status !== "pending") {
      throw new Error(`Event ${event.sync_id} is not pending`);
    }

    try {
      // Migrate event to latest schema version
      const migratedEvent = storage.migrator.migrateEvent(event, storage.migrator.latestSchemaVersion);

      if (migratedEvent === null) {
        // Event was dropped during migration (e.g., table was deleted)
        event.status = "skipped";
        event.schema_version = storage.migrator.latestSchemaVersion;
        return event;
      }

      // Update event with migrated values
      event.schema_version = migratedEvent.schema_version;
      event.type = migratedEvent.type;
      event.dataset = migratedEvent.dataset;
      event.item_id = migratedEvent.item_id;
      event.payload = migratedEvent.payload;

      storage.handleCrdtEventApply(event);
      event.status = "applied";

      if (event.origin === "local" || event.origin === "remote") {
        storage.hlc.mergeHLC(deserializeHLC(event.timestamp));
      }
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
    }
  };

  const processEnqueuedEvents = ensureSingletonExecution(async () => {
    let hasMore = true;
    while (hasMore) {
      await Promise.resolve();

      const batch = getEventsBatch({ status: "pending", limit: 100 });
      const events = batch.events;
      hasMore = batch.hasMore;

      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        transaction(() => {
          processPersistedEvent(event);
        });
      }

      dispatchEventsApplied();
    }
  });

  return {
    getEventsBatch,
    enqueueLocalEvents,
    enqueueOwnEvents,
    enqueueRemoteEvents,
    applyOwnEvent,
    dispatchEventsApplied,

    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
}
