import { sql } from "kysely";
import { deserializeHLC, type HLCCounter, serializeHLC } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { InternalSQLiteTransactionWrapper, InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import { createSQLiteCrdtApplyFunction } from "./apply-crdt-event";
import {
  CRDT_EVENT_NO_OP_PAYLOAD,
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtUpdateLogItem,
  isNoOpCrdtEventPayload,
  type PersistedCrdtEvent,
} from "./crdt-table-schema";
import { createEventHlcAccumulator } from "./event-consistency";
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

export type EnqueueEventsResult = {
  beforeSyncId: number;
  afterSyncId: number;
  /** Resolves when the enqueued events have been processed (applied/deduped/failed). */
  processed: Promise<void>;
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
  eventHlcAccumulator?: StoredValue<string>;
  onEventApplied?: (event: PersistedCrdtEvent) => void;
};

export type CrdtStorage = ReturnType<typeof createCrdtStorage>;

type EventsAppliedPayload = {
  syncId: number;
  eventHlcSum: string | null;
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

  const enqueueEvents = (
    origin: CrdtEventOrigin,
    sourceNodeId: string,
    events: EnqueuedCrdtEvent[],
  ): EnqueueEventsResult => {
    const beforeSyncId = localSyncId;
    if (events.length === 0) {
      return { beforeSyncId, afterSyncId: beforeSyncId, processed: Promise.resolve() };
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

    return { beforeSyncId, afterSyncId: localSyncId, processed: processEnqueuedEvents() };
  };

  const enqueueLocalEvents = (events: LocalCrdtEvent[], sourceNodeId: string): EnqueueEventsResult => {
    return enqueueEvents("local", sourceNodeId, events);
  };

  const enqueueOwnEvents = (events: OwnCrdtEvent[]): EnqueueEventsResult => {
    return enqueueEvents("own", storage.nodeId, events);
  };

  const enqueueRemoteEvents = (events: RemoteCrdtEvent[]): EnqueueEventsResult => {
    return enqueueEvents("remote", "", events);
  };

  const notifyEventApplied = (event: PersistedCrdtEvent) => {
    if (event.status === "applied") {
      storage.onEventApplied?.(event);
    }
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
        persistEventHlcAccumulator();
      });
    } else {
      persistEvent(db, persistedEvent);
      processPersistedEvent(db, persistedEvent);
      persistEventHlcAccumulator();
    }
  };

  const dispatchEventsApplied = (syncId = localSyncId) => {
    eventTarget.dispatchEvent("events-applied", {
      syncId,
      eventHlcSum: eventHlcAccumulator?.current ?? null,
    });
  };

  const hasPendingEvents = (): boolean => {
    const events = db.executePrepared(
      "has-pending-events",
      { status: "pending" as const },
      (db, params) =>
        db.selectFrom(crdtEventsTable).select("sync_id").where("status", "=", params("status")).limit(sql.lit(1)),
      { loggerLevel: "system" },
    );
    return events.length > 0;
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

  // Storage is quiescent when there is nothing left to converge: no events waiting
  // to be applied, and no local applied events past `pushedSyncId` still waiting to
  // be pushed to the remote. When quiescent and caught up, the local and remote node
  // share the exact same set of applied events, so their HLC checksums must match.
  const checkIsQuiescent = (pushedSyncId: number): boolean => {
    if (hasPendingEvents()) {
      return false;
    }

    const unpushed = getEventsBatch({
      status: "applied",
      afterSyncId: pushedSyncId,
      excludeOrigin: "remote",
      limit: 1,
    });

    return unpushed.events.length === 0;
  };

  const applyCrdtEvent = createSQLiteCrdtApplyFunction({
    db,
    dbConfig: storage.dbConfig,
  });
  const eventHlcAccumulator = storage.eventHlcAccumulator
    ? createEventHlcAccumulator(storage.eventHlcAccumulator.current)
    : null;

  const persistEventHlcAccumulator = () => {
    if (eventHlcAccumulator && storage.eventHlcAccumulator) {
      storage.eventHlcAccumulator.current = eventHlcAccumulator.current;
    }
  };

  const hasAcceptedEventWithTimestamp = (
    tx: InternalSQLiteTransactionWrapper<InternalDbSchema>,
    event: PersistedCrdtEvent,
  ) => {
    const [existingEvent] = tx.executePrepared(
      "get-accepted-crdt-event-by-timestamp",
      {
        timestamp: event.timestamp,
        sync_id: event.sync_id,
      },
      (db, params) =>
        db
          .selectFrom(crdtEventsTable)
          .select("sync_id")
          .where("timestamp", "=", params("timestamp"))
          .where("sync_id", "<", params("sync_id"))
          .where("status", "=", sql.lit("applied"))
          .limit(sql.lit(1)),
      { loggerLevel: "system" },
    );

    return existingEvent !== undefined;
  };

  const processPersistedEvent = (tx: InternalSQLiteTransactionWrapper<InternalDbSchema>, event: PersistedCrdtEvent) => {
    if (event.status !== "pending") {
      throw new Error(`Event ${event.sync_id} is not pending`);
    }

    try {
      if (hasAcceptedEventWithTimestamp(tx, event)) {
        event.status = "deduped";
        return event;
      }

      // Always advance HLC, even for no-op events, to maintain monotonic ordering
      if (event.origin === "local" || event.origin === "remote") {
        storage.hlc.mergeHLC(deserializeHLC(event.timestamp));
      }

      if (isNoOpCrdtEventPayload(event.payload)) {
        applyCrdtEvent(event);
        event.status = "applied";
        eventHlcAccumulator?.add(event.timestamp);
        return event;
      }

      // Migrate event to latest schema version
      const migratedEvent = storage.migrator.migrateEvent(event, storage.migrator.latestSchemaVersion);

      if (migratedEvent === null) {
        // Event was dropped during migration (e.g., table was deleted)
        event.schema_version = storage.migrator.latestSchemaVersion;
        event.payload = CRDT_EVENT_NO_OP_PAYLOAD;

        applyCrdtEvent(event);
        event.status = "applied";
        eventHlcAccumulator?.add(event.timestamp);
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
      eventHlcAccumulator?.add(event.timestamp);
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

      let appliedSyncId: number | null = null;

      db.executeTransaction((tx) => {
        for (const event of events) {
          processPersistedEvent(tx, event);
          notifyEventApplied(event);
          if (event.status === "applied") {
            appliedSyncId = event.sync_id;
          }
        }
        persistEventHlcAccumulator();
      });

      if (appliedSyncId !== null) {
        dispatchEventsApplied(appliedSyncId);
      }
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
    checkIsQuiescent,
    getEventHlcAccumulator: () => eventHlcAccumulator?.current ?? null,

    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
}
