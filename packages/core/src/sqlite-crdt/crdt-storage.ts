import { sql } from "kysely";
import { deserializeHLC, type HLCCounter, serializeHLC } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import type { SystemDbConfig } from "../migrations/system-schema";
import { CrdtEventValidationError, validateNewCrdtEvent } from "../schema/validate-crdt-event";
import type { InternalSQLiteTransactionWrapper, InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { createTypedEventTarget, ensureSingletonExecution } from "../utils";
import { createSQLiteCrdtApplyFunction } from "./apply-crdt-event";
import type { SyncDbSchema } from "./crdt-schema";
import {
  CRDT_EVENT_NO_OP_PAYLOAD,
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtUpdateLogItem,
  isNoOpCrdtEventPayload,
  type NewCrdtEvent,
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

export type CrdtChangeIntent = {
  seq: number;
  dataset: string;
  type: CrdtEventType;
  item_id: string;
  new_item_id: string | null;
  payload_json: string;
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
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig">;
};

export type CrdtStorage = Omit<ReturnType<typeof createCrdtStorage>, "internal">;

export type InternalCrdtStorage = ReturnType<typeof createCrdtStorage>;

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

  const getInitialSequentialSyncId = () => {
    const [firstPendingEvent] = db.executePrepared(
      "get-first-pending-event",
      { status: "pending" as const },
      (db, params) =>
        db
          .selectFrom(crdtEventsTable)
          .select("sync_id")
          .where("status", "=", params("status"))
          .orderBy("sync_id", "asc")
          .limit(sql.lit(1)),
      { loggerLevel: "system" },
    );

    return firstPendingEvent ? firstPendingEvent.sync_id - 1 : localSyncId;
  };

  let sequentialSyncId = getInitialSequentialSyncId();

  const eventTarget = createTypedEventTarget<{
    "events-applied": EventsAppliedPayload;
    "remote-event-apply-failed": { syncId: number };
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
      queueMicrotask(() => {
        storage.onEventApplied?.(event);
      });
    }
  };

  const applyOwnEvents = (events: OwnCrdtEvent[]) => {
    const schema = storage.schema;
    if (!schema) {
      throw new Error("applyOwnEvents requires a sync schema; none was provided to createCrdtStorage");
    }

    const validatedEvents: NewCrdtEvent[] = [];
    const errors: string[] = [];

    for (const [index, event] of events.entries()) {
      const result = validateNewCrdtEvent(schema, {
        type: event.type,
        dataset: event.dataset,
        item_id: event.item_id,
        payload: event.payload,
      });

      if (!result.success) {
        errors.push(...result.errors.map((error) => `[${index}] ${error}`));
        continue;
      }

      validatedEvents.push(result.event);
    }

    if (errors.length > 0) {
      throw new CrdtEventValidationError(errors);
    }

    db.executeTransaction((tx) => {
      for (const event of validatedEvents) {
        const persistedEvent: PersistedCrdtEvent = {
          schema_version: storage.migrator.currentSchemaVersion,
          timestamp: serializeHLC(storage.hlc.getNextHLC()),
          type: event.type,
          dataset: event.dataset,
          item_id: event.item_id,
          origin: "own-applied",
          source_node_id: storage.nodeId,
          payload: JSON.stringify(event.payload),
          sync_id: ++localSyncId,
          status: "pending",
        };

        persistEvent(tx, persistedEvent);
        applyCrdtEvent(persistedEvent);
      }
    });

    void processEnqueuedEvents();
  };

  const applyOwnEventFromTransaction = (
    tx: InternalSQLiteTransactionWrapper<InternalDbSchema>,
    event: OwnCrdtEvent,
  ) => {
    const persistedEvent: PersistedCrdtEvent = {
      schema_version: storage.migrator.currentSchemaVersion,
      timestamp: serializeHLC(storage.hlc.getNextHLC()),
      type: event.type,
      dataset: event.dataset,
      item_id: event.item_id,
      origin: "own-applied",
      source_node_id: storage.nodeId,
      payload: event.payload,
      sync_id: ++localSyncId,
      status: "pending",
    };

    persistEvent(tx, persistedEvent);
    applyCrdtEvent(persistedEvent);
  };

  const applyOwnIntentsFromTransaction = (
    tx: InternalSQLiteTransactionWrapper<InternalDbSchema>,
    intents: CrdtChangeIntent[],
  ) => {
    let appliedEvents = 0;

    for (const intent of intents) {
      if (intent.type === "item-updated") {
        if (intent.item_id !== intent.new_item_id) {
          throw new Error(
            `Cannot update the "id" column of an item. It is used to identify the item and must be immutable.`,
          );
        }
        if (intent.payload_json === "{}") {
          continue;
        }
      }

      applyOwnEventFromTransaction(tx, {
        type: intent.type,
        dataset: intent.dataset,
        item_id: intent.item_id,
        payload: intent.payload_json,
      });
      appliedEvents++;
    }

    return { appliedEvents };
  };

  const dispatchEventsApplied = (previousSequentialSyncId: number) => {
    if (sequentialSyncId <= previousSequentialSyncId) {
      return;
    }
    eventTarget.dispatchEvent("events-applied", {
      syncId: sequentialSyncId,
      eventHlcSum: sequentialSyncId === localSyncId ? (eventHlcAccumulator?.current ?? null) : null,
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
      maxSyncId: options.status === "applied" ? sequentialSyncId : localSyncId,
    };

    const filterKeys = [
      queryParams.excludeNodeId ? "nodeid" : "no-nodeid",
      queryParams.excludeOrigin ? "origin" : "no-origin",
    ];

    const events = db.executePrepared(
      `get-events-batch-${filterKeys.join("-")}`,
      queryParams,
      (db, params) =>
        db
          .selectFrom(crdtEventsTable)
          .where("sync_id", ">", params("afterSyncId"))
          .where("sync_id", "<=", params("maxSyncId"))
          .where("status", "=", params("status"))
          .$if(!!queryParams.excludeNodeId, (qb) => qb.where("source_node_id", "!=", params("excludeNodeId")))
          .$if(!!queryParams.excludeOrigin, (qb) => qb.where("origin", "!=", params("excludeOrigin")))
          .selectAll()
          .limit(params("limit"))
          .orderBy("sync_id", "asc"),
      { loggerLevel: "system" },
    );

    const hasMore = events.length > limit;
    if (hasMore) {
      events.pop();
    }

    const lastReturnedSyncId = events[events.length - 1]?.sync_id ?? options.afterSyncId ?? 0;
    let nextSyncId = lastReturnedSyncId;
    if (!hasMore && options.status === "applied") {
      nextSyncId = Math.max(lastReturnedSyncId, queryParams.maxSyncId);
    }

    return {
      events,
      hasMore,
      nextSyncId,
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

  // Rebuild the accumulator from the full applied-event history when it has
  // never been computed for this storage. An empty stored value is the "never
  // computed" sentinel: once any event is applied the accumulator is persisted
  // as padded hex, never "". This recovers storages created before the
  // accumulator existed and lets us force a recompute by bumping the stored
  // value's key version. The accumulator is a commutative sum, so scan order
  // does not matter.
  const recomputeEventHlcAccumulatorIfNeeded = () => {
    if (!eventHlcAccumulator || !storage.eventHlcAccumulator) {
      return;
    }
    if (storage.eventHlcAccumulator.current !== "") {
      return;
    }

    const batchSize = 1000;
    let afterSyncId = 0;
    for (;;) {
      const rows = db.executePrepared(
        "get-applied-event-timestamps",
        { status: "applied" as const, afterSyncId, limit: batchSize },
        (db, params) =>
          db
            .selectFrom(crdtEventsTable)
            .select(["sync_id", "timestamp"])
            .where("status", "=", params("status"))
            .where("sync_id", ">", params("afterSyncId"))
            .orderBy("sync_id", "asc")
            .limit(params("limit")),
        { loggerLevel: "system" },
      );

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        eventHlcAccumulator.add(row.timestamp);
        afterSyncId = row.sync_id;
      }

      if (rows.length < batchSize) {
        break;
      }
    }

    persistEventHlcAccumulator();
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
      if (event.origin === "own-applied") {
        event.status = "applied";
        return event;
      }

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
        return event;
      }

      const migratedEvent = storage.migrator.migrateEvent(event, storage.migrator.latestSchemaVersion);

      if (migratedEvent === null) {
        // Event was dropped during migration (e.g., table was deleted)
        event.schema_version = storage.migrator.latestSchemaVersion;
        event.payload = CRDT_EVENT_NO_OP_PAYLOAD;

        applyCrdtEvent(event);
        event.status = "applied";
        return event;
      }

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
        { loggerLevel: "system" },
      );
      hasMore = events.length > batchSize;
      if (hasMore) {
        events.pop();
      }

      const previousSequentialSyncId = sequentialSyncId;
      if (events.length === 0) {
        sequentialSyncId = localSyncId;
        dispatchEventsApplied(previousSequentialSyncId);
        break;
      }

      const failedRemoteSyncIds: number[] = [];

      db.executeTransaction((tx) => {
        for (const event of events) {
          processPersistedEvent(tx, event);
          if (event.status === "applied") {
            eventHlcAccumulator?.add(event.timestamp);
          }
          notifyEventApplied(event);
          if (event.status === "failed" && event.origin === "remote") {
            failedRemoteSyncIds.push(event.sync_id);
          }
        }
        persistEventHlcAccumulator();
      });

      sequentialSyncId = hasMore ? (events[events.length - 1]?.sync_id ?? sequentialSyncId) : localSyncId;
      dispatchEventsApplied(previousSequentialSyncId);

      // A remote event was accepted by the server but could not be applied
      // locally, which means our local state has diverged from the server.
      for (const syncId of failedRemoteSyncIds) {
        eventTarget.dispatchEvent("remote-event-apply-failed", { syncId });
      }
    }
  });

  recomputeEventHlcAccumulatorIfNeeded();

  void processEnqueuedEvents();

  return {
    getEventsBatch,
    enqueueLocalEvents,
    enqueueOwnEvents,
    enqueueRemoteEvents,
    applyOwnEvents,
    checkIsQuiescent,
    getEventHlcAccumulator: () => eventHlcAccumulator?.current ?? null,

    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,

    internal: {
      applyOwnEventFromTransaction,
      applyOwnIntentsFromTransaction,
      processEnqueuedEvents,
    },
  };
}
