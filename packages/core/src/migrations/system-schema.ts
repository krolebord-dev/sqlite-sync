import {
  CRDT_EVENT_NO_OP_PAYLOAD,
  type CrdtUpdateLogItem,
  type PersistedCrdtEvent,
} from "../sqlite-crdt/crdt-table-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createKvStoreTableQuery, createSQLiteKvStore, type KvStoreItem } from "../sqlite-kv-store";
import { type ParsedTableName, parseTableName, quoteId } from "../utils";

export type SystemDbConfig = {
  eventsTable: ParsedTableName;
  updateLogTable: ParsedTableName;
};

export function createSystemDbConfig({
  eventsTableName,
  updateLogTableName,
}: {
  eventsTableName: string;
  updateLogTableName: string;
}): SystemDbConfig {
  return {
    eventsTable: parseTableName(eventsTableName),
    updateLogTable: parseTableName(updateLogTableName),
  };
}

export type WorkerDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  "worker.kv": KvStoreItem;
  "worker.crdt_events": PersistedCrdtEvent;
};

export const workerDbConfig = createSystemDbConfig({
  eventsTableName: "worker.crdt_events",
  updateLogTableName: "crdt_update_log",
});

export type LocalDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  crdt_events: PersistedCrdtEvent;
  sync_kv: KvStoreItem;
};

export const localDbConfig = createSystemDbConfig({
  eventsTableName: "crdt_events",
  updateLogTableName: "crdt_update_log",
});

export const LOCAL_KV_TABLE_NAME = "sync_kv";

export type MemoryDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  persisted_crdt_events: PersistedCrdtEvent;
};

export const memoryDbConfig = createSystemDbConfig({
  eventsTableName: "persisted_crdt_events",
  updateLogTableName: "crdt_update_log",
});

export type SystemMigrationExecute = (sql: string, parameters?: readonly unknown[]) => { rows: unknown[] };

export type SystemMigrationContext = SystemDbConfig & {
  execute: SystemMigrationExecute;
};

export type SystemMigration = {
  version: number;
  up: (ctx: SystemMigrationContext) => void;
};

const nonNoOpEventPredicate = `"payload" <> '${CRDT_EVENT_NO_OP_PAYLOAD}'`;

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
      const indexName = `${ctx.eventsTable.table}_status_sync_id_idx`;
      ctx.execute(
        `CREATE INDEX IF NOT EXISTS ${ctx.eventsTable.schema}.${indexName} ON ${ctx.eventsTable.table} ("status", "sync_id")`,
      );
    },
  },
  {
    version: 3,
    up: (ctx: SystemMigrationContext) => {
      const indexName = `${ctx.eventsTable.table}_timestamp_status_sync_id_idx`;
      ctx.execute(
        `CREATE INDEX IF NOT EXISTS ${ctx.eventsTable.schema}.${indexName} ON ${ctx.eventsTable.table} ("timestamp", "status", "sync_id")`,
      );
    },
  },
  {
    version: 4,
    up: (ctx: SystemMigrationContext) => {
      const indexName = `${ctx.eventsTable.table}_dataset_item_id_non_no_op_idx`;
      ctx.execute(
        `CREATE INDEX IF NOT EXISTS ${ctx.eventsTable.schema}.${indexName} ON ${ctx.eventsTable.table} ("dataset", "item_id") WHERE ${nonNoOpEventPredicate}`,
      );
    },
  },
  {
    // Older builds kept an item's first create under `id` in its update log. The state hash
    // reads missing cells as written by the latest create, so lift `id` to the latest one
    // the event log still has. Applying a create that is no longer in the log fixes the rest.
    version: 5,
    up: (ctx: SystemMigrationContext) => {
      ctx.execute(`UPDATE ${quoteId(ctx.updateLogTable.fullIdentifier)} AS "log"
SET "payload" = json_set("log"."payload", '$.id', "latest"."timestamp")
FROM (
  SELECT "dataset", "item_id", max("timestamp") AS "timestamp"
  FROM ${quoteId(ctx.eventsTable.fullIdentifier)}
  WHERE "type" = 'item-created' AND "status" = 'applied' AND ${nonNoOpEventPredicate}
  GROUP BY "dataset", "item_id"
) AS "latest"
WHERE "latest"."dataset" = "log"."dataset" AND "latest"."item_id" = "log"."item_id"
  AND "latest"."timestamp" > coalesce(json_extract("log"."payload", '$.id'), '')`);
    },
  },
  {
    // Older builds left `tombstone` alone when re-applying a create, so it kept the HLC (and
    // value) of an earlier create or delete. Creates now clear it at their own HLC, so restamp
    // it with the latest create and undelete the row, as a replica replaying history would.
    version: 6,
    up: (ctx: SystemMigrationContext) => {
      const updateLog = quoteId(ctx.updateLogTable.fullIdentifier);
      const isStale = `json_extract("payload", '$.tombstone') < json_extract("payload", '$.id')`;
      const { rows } = ctx.execute(
        `SELECT DISTINCT "log"."dataset" AS "dataset" FROM ${updateLog} AS "log"
JOIN "sqlite_master" AS "master" ON "master"."type" = 'table' AND "master"."name" = "log"."dataset"
WHERE ${isStale}`,
      );
      for (const { dataset } of rows as { dataset: string }[]) {
        ctx.execute(
          `UPDATE ${quoteId(dataset)} SET "tombstone" = 0
WHERE "tombstone" <> 0 AND "id" IN (SELECT "item_id" FROM ${updateLog} WHERE "dataset" = ? AND ${isStale})`,
          [dataset],
        );
      }
      ctx.execute(
        `UPDATE ${updateLog} SET "payload" = json_set("payload", '$.tombstone', json_extract("payload", '$.id')) WHERE ${isStale}`,
      );
    },
  },
];

export function runSystemMigrations(opts: {
  version: StoredValue<number>;
  migrations: SystemMigration[];
  dbConfig: SystemDbConfig;
  execute: SystemMigrationExecute;
  transaction: (callback: () => void) => void;
}): void {
  const ctx: SystemMigrationContext = {
    ...opts.dbConfig,
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
  return applySystemDbSchema(db, { kvTableName: "worker.kv", dbConfig: workerDbConfig });
}

export function applyLocalDbSchema(db: SQLiteDbWrapper<any>) {
  return applySystemDbSchema(db, { kvTableName: LOCAL_KV_TABLE_NAME, dbConfig: localDbConfig });
}

function applySystemDbSchema(
  db: SQLiteDbWrapper<any>,
  { kvTableName, dbConfig }: { kvTableName: string; dbConfig: SystemDbConfig },
) {
  // KV table stays separate — needed before system migrations for version tracking
  db.executeKysely((kysely) => createKvStoreTableQuery(kysely.schema, kvTableName), { loggerLevel: "system" });

  // System schema migrations (each in its own transaction)
  const kvStore = createSQLiteKvStore({ db, metaTableName: kvTableName });
  runSystemMigrations({
    migrations: baseSystemMigrations,
    version: kvStore.createNumberStoredValue("internal-schema-version", -1),
    dbConfig,
    execute: (sql, parameters = []) => db.execute({ sql, parameters }, { loggerLevel: "system" }),
    transaction: (callback) => db.executeTransaction(callback),
  });

  return { kvStore };
}

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.execute(
    `CREATE TABLE IF NOT EXISTS ${memoryDbConfig.eventsTable.fullIdentifier} (
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
    `CREATE INDEX IF NOT EXISTS ${memoryDbConfig.eventsTable.table}_status_sync_id_idx ON ${memoryDbConfig.eventsTable.table} ("status", "sync_id")`,
    {
      loggerLevel: "system",
    },
  );
  db.execute(
    `CREATE INDEX IF NOT EXISTS ${memoryDbConfig.eventsTable.table}_timestamp_status_sync_id_idx ON ${memoryDbConfig.eventsTable.table} ("timestamp", "status", "sync_id")`,
    {
      loggerLevel: "system",
    },
  );
  db.execute(
    `CREATE INDEX IF NOT EXISTS ${memoryDbConfig.eventsTable.table}_dataset_item_id_non_no_op_idx ON ${memoryDbConfig.eventsTable.table} ("dataset", "item_id") WHERE ${nonNoOpEventPredicate}`,
    {
      loggerLevel: "system",
    },
  );
  db.execute(
    `CREATE TABLE IF NOT EXISTS ${memoryDbConfig.updateLogTable.fullIdentifier} (
  "dataset" text NOT NULL,
  "item_id" text NOT NULL,
  "payload" text NOT NULL,
  PRIMARY KEY ("item_id", "dataset")
)`,
    { loggerLevel: "system" },
  );
}
