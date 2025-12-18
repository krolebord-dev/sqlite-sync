import type { Kysely } from "kysely";
import { type HLCCounter, serializeHLC } from "../hlc";
import { applyMemoryDbSchema, type MemoryDbSchema } from "../migrations/system-schema";
import { applyCrdtEventMutations } from "../sqlite-crdt/apply-crdt-event";
import { createCrdtStorage, type GetEventsOptions } from "../sqlite-crdt/crdt-storage";
import { type CrdtEventStatus, type PersistedCrdtEvent, registerCrdtFunctions } from "../sqlite-crdt/crdt-table-schema";
import { applyKyselyEventsBatchFilters } from "../sqlite-crdt/events-batch-filters";
import { makeCrdtTable } from "../sqlite-crdt/make-crdt-table";
import { createSyncIdCounter } from "../sqlite-crdt/sync-id-counter";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { generateId } from "../utils";
import type { SQLiteReactiveDb } from "./sqlite-reactive-db";

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
    getEventsBatch: (opts) => getEventsBatch(db, opts),
    applyCrdtEventMutations: (event) =>
      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName: "crdt_update_log",
      }),
    updateEventStatus: (syncId, status) => updateEventStatus(db, syncId, status),
  });

  return {
    crdtStorage,
  };
}

function enqueueCrdtEvent(db: SQLiteDbWrapper<MemoryDbSchema>, event: PersistedCrdtEvent) {
  db.executePrepared(
    "enqueue-crdt-events",
    event,
    (db, params) =>
      (db as unknown as Kysely<MemoryDbSchema>).insertInto("persisted_crdt_events").values({
        status: params("status"),
        sync_id: params("sync_id"),
        type: params("type"),
        timestamp: params("timestamp"),
        dataset: params("dataset"),
        item_id: params("item_id"),
        payload: params("payload"),
        origin: params("origin"),
      }),
    { loggerLevel: "system" },
  );
}

function persistEvents(db: SQLiteDbWrapper<MemoryDbSchema>, events: PersistedCrdtEvent[]) {
  db.executeTransaction((db) => {
    const chunkSize = 100;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      db.executeKysely((db) => db.insertInto("persisted_crdt_events").values(chunk), { loggerLevel: "system" });
    }
  });
}

function getEventsBatch(db: SQLiteDbWrapper<MemoryDbSchema>, opts: GetEventsOptions) {
  return db.executeKysely(
    (db) =>
      applyKyselyEventsBatchFilters(db.selectFrom("persisted_crdt_events").selectAll(), {
        limit: 50,
        ...opts,
      }),
    { loggerLevel: "system" },
  ).rows;
}

function updateEventStatus(db: SQLiteDbWrapper<MemoryDbSchema>, syncId: number, status: CrdtEventStatus) {
  db.executePrepared(
    "update-crdt-event-status",
    { syncId, status },
    (db, params) =>
      db
        .updateTable("persisted_crdt_events")
        .set({ status: params("status") })
        .where("sync_id", "=", params("syncId")),
    { loggerLevel: "system" },
  );
}
