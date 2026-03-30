import {
  createMigrations,
  createMigrator,
  createStoredValue,
  HLCCounter,
  serializeHLC,
  type PendingCrdtEvent,
  type PersistedCrdtEvent,
  quoteId,
  type SQLiteDbWrapper,
  SQLiteReactiveDb,
} from "@sqlite-sync/core";
import { createMemoryDb } from "../../../packages/core/src/memory-db/memory-db";
import { createBenchmarkDb, noopLogger } from "./benchmarks-common";

export type BenchmarkItemRow = {
  id: string;
  value: number;
  tombstone: number;
};

export type PlainBenchmarkDbSchema = {
  benchmark_plain: BenchmarkItemRow;
};

export type SyncBenchmarkDbSchema = {
  _benchmark: BenchmarkItemRow;
  benchmark: BenchmarkItemRow;
  crdt_update_log: {
    dataset: string;
    item_id: string;
    payload: string;
  };
  persisted_crdt_events: PersistedCrdtEvent;
};

export type BenchmarkRemoteCrdtEvent = PendingCrdtEvent & {
  schema_version: number;
};

const BENCHMARK_CRDT_BASE_TABLE = "_benchmark";

const benchmarkMigrations = createMigrations((b) => ({
  0: [
    b.createTable("_benchmark", (table) =>
      table
        .addColumn("id", "text", (column) => column.primaryKey().notNull())
        .addColumn("value", "integer", (column) => column.notNull())
        .addColumn("tombstone", "integer", (column) => column.notNull().defaultTo(0)),
    ),
  ],
}));

const benchmarkSchemaVersion = Math.max(...Object.keys(benchmarkMigrations).map(Number));

export async function createPlainBenchmarkTable() {
  const db = await createBenchmarkDb<PlainBenchmarkDbSchema>();
  db.execute(`
    CREATE TABLE benchmark_plain (
      id TEXT NOT NULL PRIMARY KEY,
      value INTEGER NOT NULL,
      tombstone INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

export async function createSyncBenchmarkHarness({
  snapshot,
}: {
  snapshot?: Uint8Array<ArrayBufferLike>;
} = {}) {
  const reactiveDb = await SQLiteReactiveDb.create<SyncBenchmarkDbSchema>({
    snapshot: snapshot ?? new Uint8Array(),
    logger: noopLogger,
  });

  const schemaVersion = createStoredValue({
    initialValue: snapshot ? benchmarkSchemaVersion : -1,
  });
  const migrator = createMigrator({
    migrations: benchmarkMigrations,
    schemaVersion,
    updateLogTableName: "crdt_update_log",
  });

  if (!snapshot) {
    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        reactiveDb.db.executeTransaction((tx) => {
          callback({
            execute: (sql, parameters) => tx.execute({ sql, parameters }),
          });
        });
      },
    });
  }

  const { crdtStorage } = await createMemoryDb({
    nodeId: "bench-node",
    migrator,
    reactiveDb,
    hlcCounter: new HLCCounter("bench-node", () => Date.now()),
    crdtTables: [{ baseTableName: "_benchmark", crdtTableName: "benchmark" }],
    initializeSchema: !snapshot,
  });

  return {
    crdtStorage,
    reactiveDb,
    db: reactiveDb.db,
    dispose: () => reactiveDb.dispose(),
  };
}

export function buildBenchmarkRows(count: number, startIndex: number = 0): BenchmarkItemRow[] {
  return Array.from({ length: count }, (_, index) => {
    const id = startIndex + index + 1;
    return {
      id: `item-${id}`,
      value: id,
      tombstone: 0,
    };
  });
}

export function buildRemoteCreateEvents(
  count: number,
  { startIndex = 0, baseTimestampMs = Date.now() + 60_000 }: { startIndex?: number; baseTimestampMs?: number } = {},
): BenchmarkRemoteCrdtEvent[] {
  const rows = buildBenchmarkRows(count, startIndex);
  const hlcCounter = new HLCCounter("bench-remote", () => baseTimestampMs);

  return rows.map((row) => ({
    schema_version: benchmarkSchemaVersion,
    type: "item-created",
    dataset: BENCHMARK_CRDT_BASE_TABLE,
    item_id: row.id,
    payload: JSON.stringify(row),
    timestamp: serializeHLC(hlcCounter.getNextHLC()),
  }));
}

export function buildRemoteUpdateEvents(
  count: number,
  {
    valueOffset = 1_000_000,
    baseTimestampMs = Date.now() + 60_000,
  }: { valueOffset?: number; baseTimestampMs?: number } = {},
): BenchmarkRemoteCrdtEvent[] {
  const hlcCounter = new HLCCounter("bench-remote", () => baseTimestampMs);

  return Array.from({ length: count }, (_, index) => {
    const itemId = `item-${index + 1}`;
    return {
      schema_version: benchmarkSchemaVersion,
      type: "item-updated",
      dataset: BENCHMARK_CRDT_BASE_TABLE,
      item_id: itemId,
      payload: JSON.stringify({ value: valueOffset + index + 1 }),
      timestamp: serializeHLC(hlcCounter.getNextHLC()),
    };
  });
}

export function buildRemoteDeleteEvents(
  count: number,
  { baseTimestampMs = Date.now() + 60_000 }: { baseTimestampMs?: number } = {},
): BenchmarkRemoteCrdtEvent[] {
  const hlcCounter = new HLCCounter("bench-remote", () => baseTimestampMs);

  return Array.from({ length: count }, (_, index) => {
    const itemId = `item-${index + 1}`;
    return {
      schema_version: benchmarkSchemaVersion,
      type: "item-updated",
      dataset: BENCHMARK_CRDT_BASE_TABLE,
      item_id: itemId,
      payload: JSON.stringify({ tombstone: 1 }),
      timestamp: serializeHLC(hlcCounter.getNextHLC()),
    };
  });
}

export function insertRows(
  db: SQLiteDbWrapper<any>,
  tableName: string,
  rows: BenchmarkItemRow[],
  { chunkSize = 500 }: { chunkSize?: number } = {},
) {
  if (rows.length === 0) {
    return;
  }

  db.executeTransaction((tx) => {
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
      const parameters = chunk.flatMap((row) => [row.id, row.value, row.tombstone]);

      tx.execute({
        sql: `INSERT INTO ${quoteId(tableName)} (id, value, tombstone) VALUES ${placeholders}`,
        parameters,
      });
    }
  });
}

export function updateRows(db: SQLiteDbWrapper<any>, tableName: string, count: number, valueOffset: number = 10_000) {
  if (count === 0) {
    return;
  }

  db.executeTransaction((tx) => {
    for (let index = 0; index < count; index++) {
      const itemId = `item-${index + 1}`;
      tx.execute({
        sql: `UPDATE ${quoteId(tableName)} SET value = ? WHERE id = ?`,
        parameters: [valueOffset + index + 1, itemId],
      });
    }
  });
}

export function deleteRows(db: SQLiteDbWrapper<any>, tableName: string, count: number) {
  if (count === 0) {
    return;
  }

  db.executeTransaction((tx) => {
    for (let index = 0; index < count; index++) {
      const itemId = `item-${index + 1}`;
      tx.execute({
        sql: `DELETE FROM ${quoteId(tableName)} WHERE id = ?`,
        parameters: [itemId],
      });
    }
  });
}

export function countRows(db: SQLiteDbWrapper<any>, tableName: string) {
  return db.execute<{ count: number }>(`SELECT count(*) AS count FROM ${quoteId(tableName)}`).rows[0]?.count ?? 0;
}

export function countEvents(db: SQLiteDbWrapper<any>) {
  return db.execute<{ count: number }>("SELECT count(*) AS count FROM persisted_crdt_events").rows[0]?.count ?? 0;
}

export function countEventsByStatus(db: SQLiteDbWrapper<any>, status: PersistedCrdtEvent["status"]) {
  return (
    db.execute<{ count: number }>({
      sql: "SELECT count(*) AS count FROM persisted_crdt_events WHERE status = ?",
      parameters: [status],
    }).rows[0]?.count ?? 0
  );
}

export async function measureSyncSnapshotDurations({
  rounds,
  snapshot,
  task,
}: {
  rounds: number;
  snapshot: Uint8Array<ArrayBufferLike>;
  task: (harness: Awaited<ReturnType<typeof createSyncBenchmarkHarness>>, round: number) => void | Promise<void>;
}) {
  const durations: number[] = [];

  for (let round = 0; round < rounds; round++) {
    const harness = await createSyncBenchmarkHarness({ snapshot });

    try {
      const start = performance.now();
      await task(harness, round);
      durations.push(performance.now() - start);
    } finally {
      harness.dispose();
    }

    await Promise.resolve();
  }

  return durations;
}
