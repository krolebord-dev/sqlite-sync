import type { Kysely } from "kysely";
import { type HLCCounter, serializeHLC } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import { applyMemoryDbSchema, type MemoryDbSchema } from "../migrations/system-schema";
import { createSQLiteCrdtApplyFunction } from "../sqlite-crdt/apply-crdt-event";
import type { CrdtTableConfig } from "../sqlite-crdt/crdt-schema";
import { createCrdtStorage, type EventUpdate, type GetEventsOptions } from "../sqlite-crdt/crdt-storage";
import { type PersistedCrdtEvent, registerCrdtFunctions } from "../sqlite-crdt/crdt-table-schema";
import { applyKyselyEventsBatchFilters } from "../sqlite-crdt/events-batch-filters";
import { makeCrdtTable } from "../sqlite-crdt/make-crdt-table";
import { createStoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { generateId } from "../utils";
import type { SQLiteReactiveDb } from "./sqlite-reactive-db";

type MemoryDbOptions<Database> = {
  migrator: SyncDbMigrator;
  reactiveDb: SQLiteReactiveDb<Database>;
  hlcCounter: HLCCounter;
  tabId: string;
  crdtTables: CrdtTableConfig[];
};

export async function createMemoryDb<Database>({
  migrator,
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

  const localSyncId = createStoredValue({
    initialValue: 0,
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
        schema_version: migrator.currentSchemaVersion,
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
    migrator,
    handleCrdtEventApply: createSQLiteCrdtApplyFunction({
      db,
      updateLogTableName: "crdt_update_log",
      wrapInSavepoint: true,
    }),
    updateEvent: (syncId, update) => updateEvent(db, syncId, update),
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
        schema_version: params("schema_version"),
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
