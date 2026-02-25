import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createKvStoreTableQuery, createSQLiteKvStore, type KvStoreItem } from "../sqlite-kv-store";

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
  eventsTableName: string;
  updateLogTableName: string;
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
      ctx.execute(`CREATE TABLE IF NOT EXISTS ${ctx.eventsTableName} (
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
      ctx.execute(`CREATE TABLE IF NOT EXISTS ${ctx.updateLogTableName} (
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
      ctx.execute(`ALTER TABLE ${ctx.eventsTableName} ADD COLUMN "source_node_id" TEXT NOT NULL DEFAULT ''`);
    },
  },
];

export function runSystemMigrations(opts: {
  version: StoredValue<number>;
  migrations: SystemMigration[];
  eventsTableName: string;
  updateLogTableName: string;
  execute: (sql: string) => void;
  transaction: (callback: () => void) => void;
}): void {
  const ctx: SystemMigrationContext = {
    eventsTableName: opts.eventsTableName,
    updateLogTableName: opts.updateLogTableName,
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
    eventsTableName: '"worker"."crdt_events"',
    updateLogTableName: '"crdt_update_log"',
    execute: (sql) => db.execute(sql, { loggerLevel: "system" }),
    transaction: (callback) => db.executeTransaction(callback),
  });
}

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.execute(
    `CREATE TABLE "persisted_crdt_events" (
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
}
