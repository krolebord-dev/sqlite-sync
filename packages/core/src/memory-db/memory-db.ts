import type { HLCCounter } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import { applyMemoryDbSchema, type MemoryDbSchema } from "../migrations/system-schema";
import { createSQLiteCrdtApplyFunction } from "../sqlite-crdt/apply-crdt-event";
import type { CrdtTableConfig } from "../sqlite-crdt/crdt-schema";
import { createCrdtStorage, type EventUpdate, type GetEventsOptions } from "../sqlite-crdt/crdt-storage";
import type { PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import { applyKyselyEventsBatchFilters } from "../sqlite-crdt/events-batch-filters";
import { makeCrdtTable, registerCrdtFunctions } from "../sqlite-crdt/make-crdt-table";
import { createStoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import type { SQLiteReactiveDb } from "./sqlite-reactive-db";

type MemoryDbOptions<Database> = {
  migrator: SyncDbMigrator;
  reactiveDb: SQLiteReactiveDb<Database>;
  hlcCounter: HLCCounter;
  crdtTables: CrdtTableConfig[];
};

export async function createMemoryDb<Database>({
  migrator,
  reactiveDb: _reactiveDb,
  hlcCounter,
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

  const localSyncId = createStoredValue({
    initialValue: 0,
  });

  const crdtStorage = createCrdtStorage({
    syncId: localSyncId,
    hlc: hlcCounter,
    persistEvent: (event) => persistEvent(db, event),
    getEventsBatch: (opts) => getEventsBatch(db, opts),
    migrator,
    handleCrdtEventApply: createSQLiteCrdtApplyFunction({
      db,
      updateLogTableName: "crdt_update_log",
    }),
    updateEvent: (syncId, update) => updateEvent(db, syncId, update),
    transaction: (callback) => db.executeTransaction(callback),
  });

  registerCrdtFunctions({
    reactiveDb,
    storage: crdtStorage,
  });

  return {
    crdtStorage,
  };
}

function persistEvent(db: SQLiteDbWrapper<MemoryDbSchema>, event: PersistedCrdtEvent) {
  db.executePrepared(
    "persist-crdt-event",
    event,
    (db, params) =>
      db.insertInto("persisted_crdt_events").values({
        type: params("type"),
        dataset: params("dataset"),
        item_id: params("item_id"),
        payload: params("payload"),
        schema_version: params("schema_version"),
        sync_id: params("sync_id"),
        status: params("status"),
        timestamp: params("timestamp"),
        origin: params("origin"),
      }),
    { loggerLevel: "system" },
  );
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

function updateEvent(db: SQLiteDbWrapper<MemoryDbSchema>, syncId: number, update: EventUpdate) {
  db.executePrepared(
    "update-crdt-event",
    { syncId, ...update },
    (db, params) =>
      db
        .updateTable("persisted_crdt_events")
        .set({
          status: params("status"),
          schema_version: params("schema_version"),
          type: params("type"),
          dataset: params("dataset"),
          item_id: params("item_id"),
          payload: params("payload"),
        })
        .where("sync_id", "=", params("syncId")),
    { loggerLevel: "system" },
  );
}
