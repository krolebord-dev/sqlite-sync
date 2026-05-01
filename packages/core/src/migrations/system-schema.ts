import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createKvStoreTableQuery, createSQLiteKvStore, type KvStoreItem } from "../sqlite-kv-store";
import { type ParsedTableName, parseTableName, quoteId } from "../utils";

export type WorkerDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  "worker.kv": KvStoreItem;
  "worker.crdt_events": PersistedCrdtEvent;
};

export type MemoryDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  persisted_crdt_events: PersistedCrdtEvent;
};

export type SystemMigrationContext = {
  eventsTable: ParsedTableName;
  eventsStatusSyncIdIndexName?: string;
  updateLogTable: ParsedTableName;
  execute: (sql: string) => void;
};

export type SystemMigration = {
  version: number;
  up: (ctx: SystemMigrationContext) => void;
};

export const baseSystemMigrations: SystemMigration[] = [
  {
    version: 0,
    up: (ctx: SystemMigrationContext) => {
      ctx.execute(`CREATE TABLE IF NOT EXISTS ${ctx.eventsTable.fullIdentifier} (
        "sync_id" integer NOT NULL PRIMARY KEY,
        "schema_version" integer NOT NULL,
        "status" text NOT NULL,
        "type" text NOT NULL,
        "timestamp" text NOT NULL,
        "origin" text NOT NULL,
        "dataset" text NOT NULL,
        "item_id" text NOT NULL,
        "payload" text NOT NULL
      )`);
      ctx.execute(`CREATE TABLE IF NOT EXISTS ${ctx.updateLogTable.fullIdentifier} (
        "dataset" text NOT NULL,
        "item_id" text NOT NULL,
        "payload" text NOT NULL,
        PRIMARY KEY ("item_id", "dataset")
      )`);
    },
  },
  {
    version: 1,
    up: (ctx: SystemMigrationContext) => {
      ctx.execute(`ALTER TABLE ${ctx.eventsTable.fullIdentifier} ADD COLUMN "source_node_id" TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    version: 2,
    up: (ctx: SystemMigrationContext) => {
      const indexName = quoteId(ctx.eventsStatusSyncIdIndexName ?? `${ctx.eventsTable.table}_status_sync_id_idx`);
      ctx.execute(
        `CREATE INDEX IF NOT EXISTS ${quoteId(ctx.eventsTable.schema)}.${quoteId(indexName)} ON ${quoteId(ctx.eventsTable.table)} ("status", "sync_id")`,
      );
    },
  },
];

export function runSystemMigrations(opts: {
  version: StoredValue<number>;
  migrations: SystemMigration[];
  eventsTableName: string;
  eventsStatusSyncIdIndexName?: string;
  updateLogTableName: string;
  execute: (sql: string) => void;
  transaction: (callback: () => void) => void;
}): void {
  const ctx: SystemMigrationContext = {
    eventsTable: parseTableName(opts.eventsTableName),
    eventsStatusSyncIdIndexName: opts.eventsStatusSyncIdIndexName,
    updateLogTable: parseTableName(opts.updateLogTableName),
    execute: opts.execute,
  };
  for (const migration of opts.migrations) {
    if (migration.version > opts.version.current) {
      opts.transaction(() => {
        migration.up(ctx);
        opts.version.current = migration.version;
      });
    }
  }
}

export function applyWorkerDbSchema(db: SQLiteDbWrapper<any>) {
  // KV table stays separate — needed before system migrations for version tracking
  db.executeKysely((kysely) => createKvStoreTableQuery(kysely.schema, "worker.kv"), { loggerLevel: "system" });

  // System schema migrations (each in its own transaction)
  const kvStore = createSQLiteKvStore({ db, metaTableName: "worker.kv" });
  runSystemMigrations({
    migrations: baseSystemMigrations,
    version: kvStore.createNumberStoredValue("internal-schema-version", -1),
    eventsTableName: "worker.crdt_events",
    updateLogTableName: "crdt_update_log",
    execute: (sql) => db.execute(sql, { loggerLevel: "system" }),
    transaction: (callback) => db.executeTransaction(callback),
  });

  return { kvStore };
}

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteId("persisted_crdt_events")} (
  "sync_id" integer NOT NULL PRIMARY KEY,
  "schema_version" integer NOT NULL,
  "status" text NOT NULL,
  "type" text NOT NULL,
  "timestamp" text NOT NULL,
  "origin" text NOT NULL,
  "source_node_id" text NOT NULL DEFAULT '',
  "dataset" text NOT NULL,
  "item_id" text NOT NULL,
  "payload" text NOT NULL
  )`,
    { loggerLevel: "system" },
  );
  db.execute(
    `CREATE INDEX IF NOT EXISTS "persisted_crdt_events_status_sync_id_idx" ON "persisted_crdt_events" ("status", "sync_id")`,
    {
      loggerLevel: "system",
    },
  );
  db.execute(
    `CREATE TABLE IF NOT EXISTS ${quoteId("crdt_update_log")} (
  "dataset" text NOT NULL,
  "item_id" text NOT NULL,
  "payload" text NOT NULL,
  PRIMARY KEY ("item_id", "dataset")
)`,
    { loggerLevel: "system" },
  );
}
