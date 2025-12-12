import { sql, type Kysely } from "kysely";
import { HLCCounter, serializeHLC } from "../hlc";
import {
  applyMemoryDbSchema,
  type MemoryDbSchema,
} from "../migrations/system-schema";
import {
  registerCrdtFunctions,
  type CrdtEventStatus,
  type PersistedCrdtEvent,
} from "../sqlite-crdt/crdt-table-schema";
import { makeCrdtTable } from "../sqlite-crdt/make-crdt-table";
import { createSyncIdCounter } from "../sqlite-crdt/sync-id-counter";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createCrdtStorage } from "../sqlite-crdt/crdt-storage";
import { applyCrdtEventMutations } from "../sqlite-crdt/apply-crdt-event";
import type { SQLiteReactiveDb } from "./sqlite-reactive-db";
import { generateId } from "../utils";

export type MemoryDbCrdtTableConfig = {
  baseTableName: string;
  crdtTableName: string;
};

type MemoryDbOptions<Database> = {
  reactiveDb: SQLiteReactiveDb<Database>;
  hlcCounter: HLCCounter;
  tabId: string;
  crdtTables: MemoryDbCrdtTableConfig[];
};

export async function createMemoryDb<Database>({
  reactiveDb: _reactiveDb,
  hlcCounter,
  tabId,
  crdtTables,
}: MemoryDbOptions<Database>) {
  const reactiveDb = _reactiveDb as unknown as SQLiteReactiveDb<MemoryDbSchema>;
  const db = reactiveDb.db;

  applyMemoryDbSchema(db);
  for (const table of crdtTables) {
    makeCrdtTable({
      db,
      baseTableName: table.baseTableName,
      crdtTableName: table.crdtTableName,
    });
  }

  const localSyncId = createSyncIdCounter({
    initialSyncId: 0,
  });

  const pendingLocalEvents: PersistedCrdtEvent[] = [];
  registerCrdtFunctions({
    db,
    getTableSchema: (dataset: string) => db.dbSchema[dataset],
    getNextTimestamp: () => serializeHLC(hlcCounter.getNextHLC()),
    updateLogTableName: "crdt_update_log",
    onEventApplied: (event) => {
      const persistedEvent: PersistedCrdtEvent = {
        ...event,
        origin: tabId,
        sync_id: ++localSyncId.current,
        status: "applied" as const,
      };
      enqueueCrdtEvent(db, persistedEvent);
      pendingLocalEvents.push(persistedEvent);
    },
  });
  db.createScalarFunction({
    name: "gen_id",
    callback: () => generateId(),
    deterministic: false,
    directOnly: false,
    innocuous: true,
  });

  reactiveDb.addEventListener("transaction-rolled-back", () => {
    pendingLocalEvents.length = 0;
  });
  reactiveDb.addEventListener("transaction-committed", () => {
    const appliedEvents = pendingLocalEvents.splice(0);
    queueMicrotask(() => {
      for (const event of appliedEvents) {
        crdtStorage.dispatchEvent("event-applied", event);
      }
      crdtStorage.dispatchEvent("event-processing-done", undefined);
    });
  });

  const crdtStorage = createCrdtStorage({
    syncId: localSyncId,
    persistEvents: (events) => persistEvents(db, events),
    popPendingEventsBatch: () => popPendingEventsBatch(db, 50),
    applyCrdtEventMutations: (event) =>
      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName: "crdt_update_log",
      }),
    updateEventStatus: (syncId, status) =>
      updateEventStatus(db, syncId, status),
  });

  return {
    crdtStorage,
  };
}

function enqueueCrdtEvent(
  db: SQLiteDbWrapper<MemoryDbSchema>,
  event: PersistedCrdtEvent
) {
  db.executePrepared("enqueue-crdt-events", event, (db, params) =>
    (db as unknown as Kysely<MemoryDbSchema>)
      .insertInto("persisted_crdt_events")
      .values({
        status: params("status"),
        sync_id: params("sync_id"),
        type: params("type"),
        timestamp: params("timestamp"),
        dataset: params("dataset"),
        item_id: params("item_id"),
        payload: params("payload"),
        origin: params("origin"),
      })
  );
}

function persistEvents(
  db: SQLiteDbWrapper<MemoryDbSchema>,
  events: PersistedCrdtEvent[]
) {
  db.executeTransaction((db) => {
    const chunkSize = 100;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      db.executeKysely((db) =>
        db.insertInto("persisted_crdt_events").values(chunk)
      );
    }
  });
}

function popPendingEventsBatch(
  db: SQLiteDbWrapper<MemoryDbSchema>,
  limit: number
) {
  const events = db.executePrepared(
    "pop-enqueued-crdt-events",
    {
      limit: limit,
    },
    (db, param) =>
      db
        .selectFrom("persisted_crdt_events")
        .where("status", "=", sql.lit("pending"))
        .limit(param("limit"))
        .orderBy("sync_id", "asc")
        .selectAll()
  );
  return {
    events,
    hasMore: events.length === limit,
  };
}

function updateEventStatus(
  db: SQLiteDbWrapper<MemoryDbSchema>,
  syncId: number,
  status: CrdtEventStatus
) {
  db.executePrepared(
    "update-crdt-event-status",
    { syncId, status },
    (db, params) =>
      db
        .updateTable("persisted_crdt_events")
        .set({ status: params("status") })
        .where("sync_id", "=", params("syncId"))
  );
}
