import { createSQLiteKvStore, type SQLiteDbWrapper } from "@sqlite-sync/core";
import { createBenchmarkDb, type MeasurementRow, measureDurations, summarizeDurations } from "../src/benchmarks-common";

type VariantName = "rowid" | "without-rowid";

type VariantMeasurementRow = MeasurementRow & {
  variant: VariantName;
  operationsPerWorkload: number;
  throughputOpsPerSecond: number;
};

export type KvStoreRowIdComparisonRow = {
  workload: string;
  rowid: VariantMeasurementRow;
  withoutRowid: VariantMeasurementRow;
  fasterVariant: VariantName;
  deltaPercent: number;
};

export type KvStoreRowIdBenchmarkResult = {
  keyCount: number;
  iterations: number;
  rounds: number;
  rows: KvStoreRowIdComparisonRow[];
  sanity: string[];
};

type VariantHarness = {
  db: SQLiteDbWrapper<any>;
  store: KvStore;
  existingKeys: string[];
};

type Workload = {
  name: string;
  operationsPerWorkload: (opts: { keyCount: number; iterations: number }) => number;
  mutates: boolean;
  run: (harness: VariantHarness, round: number, opts: { keyCount: number; iterations: number }) => void;
  sanityCheck: (harness: VariantHarness, opts: { keyCount: number; iterations: number }) => string;
};

const TABLE_NAME = "meta_table";
type KvStore = ReturnType<typeof createSQLiteKvStore>;

const WORKLOADS: Workload[] = [
  {
    name: "get(existing)",
    operationsPerWorkload: ({ iterations }) => iterations,
    mutates: false,
    run: (harness, _round, { keyCount, iterations }) => {
      for (let index = 0; index < iterations; index++) {
        const key = harness.existingKeys[index % keyCount];
        if (harness.store.get(key) === null) {
          throw new Error(`Missing seeded key during get workload: ${key}`);
        }
      }
    },
    sanityCheck: (harness, { keyCount }) => {
      const hits = harness.existingKeys.slice(0, Math.min(3, keyCount)).map((key) => harness.store.get(key));
      return `get(existing): sample values ${hits.join(", ")}`;
    },
  },
  {
    name: "set(existing)",
    operationsPerWorkload: ({ iterations }) => iterations,
    mutates: true,
    run: (harness, round, { keyCount, iterations }) => {
      for (let index = 0; index < iterations; index++) {
        const key = harness.existingKeys[index % keyCount];
        harness.store.set(key, `updated-${round}-${index}`);
      }
    },
    sanityCheck: (harness) => {
      harness.store.set(harness.existingKeys[0], "sanity-update");
      return `set(existing): ${harness.existingKeys[0]} => ${harness.store.get(harness.existingKeys[0])}`;
    },
  },
  {
    name: "set(new)",
    operationsPerWorkload: ({ iterations }) => iterations,
    mutates: true,
    run: (harness, round, { iterations }) => {
      for (let index = 0; index < iterations; index++) {
        harness.store.set(`new-key-${round}-${index}`, `new-value-${index}`);
      }
    },
    sanityCheck: (harness, { iterations, keyCount }) => {
      for (let index = 0; index < iterations; index++) {
        harness.store.set(`sanity-key-${index}`, `value-${index}`);
      }
      const count = countRows(harness.db);
      return `set(new): ${count} rows after inserting ${iterations} new keys (baseline ${keyCount})`;
    },
  },
  {
    name: "remove(existing)",
    operationsPerWorkload: ({ keyCount, iterations }) => Math.min(keyCount, iterations),
    mutates: true,
    run: (harness, _round, { keyCount, iterations }) => {
      const deleteCount = Math.min(keyCount, iterations);
      for (let index = 0; index < deleteCount; index++) {
        harness.store.remove(harness.existingKeys[index]);
      }
    },
    sanityCheck: (harness, { keyCount, iterations }) => {
      const deleteCount = Math.min(keyCount, iterations);
      for (let index = 0; index < deleteCount; index++) {
        harness.store.remove(harness.existingKeys[index]);
      }
      return `remove(existing): ${countRows(harness.db)} rows remain after deleting ${deleteCount} keys`;
    },
  },
];

export async function runSqliteKvStoreRowIdBenchmark({
  keyCount,
  iterations,
  rounds,
  onStatus,
}: {
  keyCount: number;
  iterations: number;
  rounds: number;
  onStatus?: (status: string) => void;
}): Promise<KvStoreRowIdBenchmarkResult> {
  const normalizedKeyCount = normalizePositiveInteger(keyCount);
  const normalizedIterations = normalizePositiveInteger(iterations);
  const normalizedRounds = normalizePositiveInteger(rounds);
  const rows: KvStoreRowIdComparisonRow[] = [];
  const sanity: string[] = [];

  for (const workload of WORKLOADS) {
    onStatus?.(`measuring ${workload.name}...`);

    const rowid = await measureVariantWorkload({
      variant: "rowid",
      workload,
      keyCount: normalizedKeyCount,
      iterations: normalizedIterations,
      rounds: normalizedRounds,
    });
    const withoutRowid = await measureVariantWorkload({
      variant: "without-rowid",
      workload,
      keyCount: normalizedKeyCount,
      iterations: normalizedIterations,
      rounds: normalizedRounds,
    });

    const fasterVariant = rowid.meanMs <= withoutRowid.meanMs ? "rowid" : "without-rowid";
    const slowerMean = Math.max(rowid.meanMs, withoutRowid.meanMs);
    const fasterMean = Math.min(rowid.meanMs, withoutRowid.meanMs);
    const deltaPercent = slowerMean === 0 ? 0 : ((slowerMean - fasterMean) / slowerMean) * 100;

    rows.push({
      workload: workload.name,
      rowid,
      withoutRowid,
      fasterVariant,
      deltaPercent,
    });

    const sanityHarness = await createVariantHarness(fasterVariant, normalizedKeyCount);
    try {
      sanity.push(
        `${workload.name} (${fasterVariant}): ${runSanityCheck(sanityHarness, workload, {
          keyCount: normalizedKeyCount,
          iterations: normalizedIterations,
        })}`,
      );
    } finally {
      sanityHarness.db.close();
    }
  }

  onStatus?.("ready");

  return {
    keyCount: normalizedKeyCount,
    iterations: normalizedIterations,
    rounds: normalizedRounds,
    rows,
    sanity,
  };
}

async function measureVariantWorkload({
  variant,
  workload,
  keyCount,
  iterations,
  rounds,
}: {
  variant: VariantName;
  workload: Workload;
  keyCount: number;
  iterations: number;
  rounds: number;
}): Promise<VariantMeasurementRow> {
  const harness = await createVariantHarness(variant, keyCount);

  try {
    const durations = await measureDurations({
      rounds,
      task: async (round) => {
        runMeasuredWorkload(harness, workload, {
          keyCount,
          iterations,
          round,
        });
      },
    });

    const summary = summarizeDurations(`${workload.name} (${variant})`, durations);
    const operationsPerWorkload = workload.operationsPerWorkload({ keyCount, iterations });

    return {
      ...summary,
      variant,
      operationsPerWorkload,
      throughputOpsPerSecond: operationsPerWorkload / (summary.meanMs / 1_000),
    };
  } finally {
    harness.db.close();
  }
}

function runMeasuredWorkload(
  harness: VariantHarness,
  workload: Workload,
  opts: {
    keyCount: number;
    iterations: number;
    round: number;
  },
) {
  if (!workload.mutates) {
    workload.run(harness, opts.round, opts);
    return;
  }

  const transaction = harness.db.beginTransaction();
  try {
    workload.run(harness, opts.round, opts);
  } finally {
    transaction.rollback();
  }
}

function runSanityCheck(
  harness: VariantHarness,
  workload: Workload,
  opts: {
    keyCount: number;
    iterations: number;
  },
) {
  if (!workload.mutates) {
    return workload.sanityCheck(harness, opts);
  }

  const transaction = harness.db.beginTransaction();
  try {
    return workload.sanityCheck(harness, opts);
  } finally {
    transaction.rollback();
  }
}

async function createVariantHarness(variant: VariantName, keyCount: number): Promise<VariantHarness> {
  const db = await createBenchmarkDb();
  db.execute(createTableSql(variant));
  seedMetaTable(db, keyCount);

  const store = createSQLiteKvStore({
    db,
    metaTableName: TABLE_NAME,
  });

  const existingKeys = Array.from({ length: keyCount }, (_, index) => `key-${index}`);

  const transaction = db.beginTransaction();
  try {
    store.get(existingKeys[0]);
    store.set(existingKeys[0], "prewarm");
    store.remove("__missing__");
  } finally {
    transaction.rollback();
  }

  return {
    db,
    store,
    existingKeys,
  };
}

function seedMetaTable(db: SQLiteDbWrapper<any>, keyCount: number) {
  const insertStatement = db.prepare<[string, string], never>(`INSERT INTO ${TABLE_NAME} (key, value) VALUES (?, ?)`);

  try {
    db.executeTransaction(() => {
      for (let index = 0; index < keyCount; index++) {
        insertStatement.execute([`key-${index}`, `value-${index}`]);
      }
    });
  } finally {
    insertStatement.finalize();
  }
}

function countRows(db: SQLiteDbWrapper<any>) {
  return db.execute<{ count: number }>(`SELECT count(*) AS count FROM ${TABLE_NAME}`).rows[0]?.count ?? 0;
}

function createTableSql(variant: VariantName) {
  const withoutRowidClause = variant === "without-rowid" ? " WITHOUT ROWID" : "";
  return `CREATE TABLE ${TABLE_NAME} (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )${withoutRowidClause}`;
}

function normalizePositiveInteger(value: number) {
  return Math.max(1, Math.floor(Number(value) || 1));
}
