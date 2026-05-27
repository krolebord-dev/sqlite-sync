import { xxhash } from "../hash";
import type { HLCCounter } from "../hlc";
import type { SyncDbMigrator } from "../migrations/migrator";
import { applyMemoryDbSchema, type MemoryDbSchema, memoryDbConfig } from "../migrations/system-schema";
import type { CrdtTableConfig } from "../sqlite-crdt/crdt-schema";
import { createCrdtStorage } from "../sqlite-crdt/crdt-storage";
import { makeCrdtTable, registerCrdtFunctions } from "../sqlite-crdt/make-crdt-table";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import type { SQLiteReactiveDb } from "./sqlite-reactive-db";

type MemoryDbOptions<Database> = {
  nodeId: string;
  migrator: SyncDbMigrator;
  reactiveDb: SQLiteReactiveDb<Database>;
  hlcCounter: HLCCounter;
  crdtTables: CrdtTableConfig[];
  initializeSchema?: boolean;
  initialSyncId?: number;
  eventHlcAccumulator?: StoredValue<string>;
};

export async function createMemoryDb<Database>({
  nodeId,
  migrator,
  reactiveDb: _reactiveDb,
  hlcCounter,
  crdtTables,
  initializeSchema = true,
  initialSyncId,
  eventHlcAccumulator,
}: MemoryDbOptions<Database>) {
  await xxhash.ensureLoaded();

  const reactiveDb = _reactiveDb as unknown as SQLiteReactiveDb<MemoryDbSchema>;
  const db = reactiveDb.db;

  if (initializeSchema) {
    applyMemoryDbSchema(db);
    for (const table of crdtTables) {
      makeCrdtTable({
        db,
        baseTableName: table.baseTableName,
        crdtTableName: table.crdtTableName,
      });
    }
  }

  const crdtStorage = createCrdtStorage({
    nodeId,
    initialLocalSyncId: initialSyncId ?? getCurrentSyncId(db),
    hlc: hlcCounter,
    migrator,
    db,
    dbConfig: memoryDbConfig,
    eventHlcAccumulator,
  });

  registerCrdtFunctions({
    reactiveDb,
    storage: crdtStorage,
  });

  return {
    crdtStorage,
  };
}

function getCurrentSyncId(db: SQLiteDbWrapper<MemoryDbSchema>) {
  return (
    db.execute<{ syncId: number }>("SELECT coalesce(max(sync_id), 0) AS syncId FROM persisted_crdt_events", {
      loggerLevel: "system",
    }).rows[0]?.syncId ?? 0
  );
}
