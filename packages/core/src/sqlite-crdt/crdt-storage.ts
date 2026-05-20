import { deserializeHLC, type HLCCounter, serializeHLC } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { InternalSQLiteTransactionWrapper, InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import { createSQLiteCrdtApplyFunction } from "./apply-crdt-event";
import type {
  CrdtEventOrigin,
  CrdtEventStatus,
  CrdtEventType,
  CrdtUpdateLogItem,
  PersistedCrdtEvent,
} from "./crdt-table-schema";

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
  excludeNodeId?: string;
  limit?: number;
};

export type GetEventsBatchQuery = {
  afterSyncId: number;
  status: CrdtEventStatus;
  limit: number;
} & (
  | { excludeOrigin: CrdtEventOrigin; excludeNodeId?: undefined }
  | { excludeOrigin?: undefined; excludeNodeId: string }
);

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
  nodeId: string;
  initialLocalSyncId: number;
  migrator: SyncDbMigrator;
  db: InternalSQLiteWrapper<any>;
  dbConfig: SystemDbConfig;
  hlc: StorageHLC;
  onEventApplied?: (event: PersistedCrdtEvent) => void;
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

type InternalDbSchema = {
  _crdt_events: PersistedCrdtEvent;
  _crdt_update_log: CrdtUpdateLogItem;
};

export function createCrdtStorage(storage: DbSyncerStorage) {
  let localSyncId = storage.initialLocalSyncId;

  const db = storage.db as InternalSQLiteWrapper<InternalDbSchema>;

  const crdtEventsTable = storage.dbConfig.eventsTable.fullIdentifier as "_crdt_events";

  const eventTarget = createTypedEventTarget<{
    "events-applied": EventsAppliedPayload;
  }>();

  const persistEvent = (tx: InternalSQLiteTransactionWrapper<InternalDbSchema>, event: PersistedCrdtEvent) => {
    tx.executePrepared(
      "persist-crdt-event",
      event,
      (db, params) =>
        db.insertInto(crdtEventsTable).values({
          type: params("type"),
          dataset: params("dataset"),
          item_id: params("item_id"),
          payload: params("payload"),
          schema_version: params("schema_version"),
          sync_id: params("sync_id"),
          status: params("status"),
          timestamp: params("timestamp"),
          origin: params("origin"),
          source_node_id: params("source_node_id"),
        }),
      { loggerLevel: "system" },
    );
  };

  const enqueueEvents = (origin: CrdtEventOrigin, sourceNodeId: string, events: EnqueuedCrdtEvent[]) => {
    if (events.length === 0) {
      return;
    }

    db.executeTransaction((tx) => {
      for (const event of events) {
        persistEvent(tx, {
          schema_version: event.schema_version ?? storage.migrator.currentSchemaVersion,
          timestamp: event.timestamp ?? serializeHLC(storage.hlc.getNextHLC()),
          type: event.type,
          dataset: event.dataset,
          item_id: event.item_id,
          origin: origin,
          source_node_id: sourceNodeId,
          payload: event.payload,
          sync_id: ++localSyncId,
          status: "pending",
        });
      }
    });

    return processEnqueuedEvents();
  };

  const enqueueLocalEvents = (events: LocalCrdtEvent[], sourceNodeId: string): void => {
    // biome-ignore lint/correctness/noVoidTypeReturn: We need to return void to match the type signature of the function
    return enqueueEvents("local", sourceNodeId, events) as undefined;
  };

  const enqueueOwnEvents = (events: OwnCrdtEvent[]): void => {
    // biome-ignore lint/correctness/noVoidTypeReturn: We need to return void to match the type signature of the function
    return enqueueEvents("own", storage.nodeId, events) as undefined;
  };

  const enqueueRemoteEvents = (events: RemoteCrdtEvent[]): void => {
    // biome-ignore lint/correctness/noVoidTypeReturn: We need to return void to match the type signature of the function
    return enqueueEvents("remote", "", events) as undefined;
  };

  const applyOwnEvent = (event: OwnCrdtEvent, { wrapInTransaction }: { wrapInTransaction?: boolean } = {}) => {
    const persistedEvent: PersistedCrdtEvent = {
      schema_version: storage.migrator.currentSchemaVersion,
      timestamp: serializeHLC(storage.hlc.getNextHLC()),
      type: event.type,
      dataset: event.dataset,
      item_id: event.item_id,
      origin: "own",
      source_node_id: storage.nodeId,
      payload: event.payload,
      sync_id: ++localSyncId,
      status: "pending",
    };

    if (wrapInTransaction) {
      db.executeTransaction((tx) => {
        persistEvent(tx, persistedEvent);
        processPersistedEvent(tx, persistedEvent);
      });
    } else {
      persistEvent(db, persistedEvent);
      processPersistedEvent(db, persistedEvent);
    }
  };

  const dispatchEventsApplied = () => {
    eventTarget.dispatchEvent("events-applied", {
      syncId: localSyncId,
    });
  };

  const getEventsBatch = (options: GetEventsBatchQuery): GetEventsBatch => {
    const limit = options.limit ?? 50;

    const queryParams = {
      limit: limit + 1,
      status: options.status ?? null,
      afterSyncId: options.afterSyncId ?? null,
      excludeOrigin: options.excludeOrigin ?? null,
      excludeNodeId: options.excludeNodeId ?? null,
    };

    const filterKeys = [
      queryParams.excludeNodeId ? "nodeid" : "no-nodeid",
      queryParams.excludeOrigin ? "origin" : "no-origin",
    ];

    const events = db.executePrepared(`get-events-batch-${filterKeys.join("-")}`, queryParams, (db, params) =>
      db
        .selectFrom(crdtEventsTable)
        .where("sync_id", ">", params("afterSyncId"))
        .where("status", "=", params("status"))
        .$if(!!queryParams.excludeNodeId, (qb) => qb.where("source_node_id", "!=", params("excludeNodeId")))
        .$if(!!queryParams.excludeOrigin, (qb) => qb.where("origin", "!=", params("excludeOrigin")))
        .selectAll()
        .limit(params("limit"))
        .orderBy("sync_id", "asc"),
    );

    const hasMore = events.length > limit;
    if (hasMore) {
      events.pop();
    }
    return {
      events,
      hasMore,
      nextSyncId: events[events.length - 1]?.sync_id ?? options.afterSyncId ?? 0,
    };
  };

  const applyCrdtEvent = createSQLiteCrdtApplyFunction({
    db,
    dbConfig: storage.dbConfig,
  });

  const processPersistedEvent = (tx: InternalSQLiteTransactionWrapper<InternalDbSchema>, event: PersistedCrdtEvent) => {
    if (event.status !== "pending") {
      throw new Error(`Event ${event.sync_id} is not pending`);
    }

    try {
      // Always advance HLC, even for skipped events, to maintain monotonic ordering
      if (event.origin === "local" || event.origin === "remote") {
        storage.hlc.mergeHLC(deserializeHLC(event.timestamp));
      }

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

      applyCrdtEvent(event);
      event.status = "applied";
    } catch (error) {
      console.error("Error applying enqueued CRDT event", error);
      event.status = "failed";
    } finally {
      tx.executePrepared(
        "update-crdt-event",
        event,
        (db, params) =>
          db
            .updateTable(crdtEventsTable)
            .set({
              status: params("status"),
              schema_version: params("schema_version"),
              type: params("type"),
              dataset: params("dataset"),
              item_id: params("item_id"),
              payload: params("payload"),
            })
            .where("sync_id", "=", params("sync_id")),
        { loggerLevel: "system" },
      );
    }
  };

  const processEnqueuedEvents = ensureSingletonExecution(async () => {
    let hasMore = true;
    while (hasMore) {
      await Promise.resolve();

      const batchSize = 100;

      const events = db.executePrepared(
        "get-enqueued-pending-events",
        {
          status: "pending" as const,
          limit: batchSize + 1,
        },
        (db, params) =>
          db
            .selectFrom(crdtEventsTable)
            .selectAll()
            .where("status", "=", params("status"))
            .limit(params("limit"))
            .orderBy("sync_id", "asc"),
      );
      hasMore = events.length > batchSize;
      if (hasMore) {
        events.pop();
      }

      if (events.length === 0) {
        break;
      }

      db.executeTransaction((tx) => {
        for (const event of events) {
          processPersistedEvent(tx, event);
          storage.onEventApplied?.(event);
        }
      });

      dispatchEventsApplied();
    }
  });

  void processEnqueuedEvents();

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
