const JOBS_SCHEMA_VERSION_KEY = "jobs-schema-version";

export const JOBS_TABLE = "__jobs";
export const JOB_SCHEDULES_TABLE = "__job_schedules";

type JobsSchemaMigration = {
  version: number;
  up: (storage: DurableObjectStorage) => void;
};

const jobsSchemaMigrations: JobsSchemaMigration[] = [
  {
    version: 0,
    up: (storage) => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS "${JOBS_TABLE}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "type" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "payload" TEXT NOT NULL,
        "scheduled_at" INTEGER NOT NULL,
        "started_at" INTEGER,
        "finished_at" INTEGER,
        "error_message" TEXT,
        "error_stack" TEXT,
        "schedule_id" TEXT,
        "created_at" INTEGER NOT NULL,
        "updated_at" INTEGER NOT NULL
      )`);

      storage.sql.exec(`CREATE INDEX IF NOT EXISTS "idx_jobs_due" ON "${JOBS_TABLE}" ("status", "scheduled_at", "id")`);

      storage.sql.exec(`CREATE TABLE IF NOT EXISTS "${JOB_SCHEDULES_TABLE}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "type" TEXT NOT NULL,
        "dedupe_key" TEXT NOT NULL,
        "payload" TEXT NOT NULL,
        "interval_ms" INTEGER NOT NULL,
        "next_run_at" INTEGER NOT NULL,
        "status" TEXT NOT NULL,
        "created_at" INTEGER NOT NULL,
        "updated_at" INTEGER NOT NULL,
        "last_run_at" INTEGER
      )`);

      storage.sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_job_schedules_type_key" ON "${JOB_SCHEDULES_TABLE}" ("type", "dedupe_key")`,
      );
      storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS "idx_job_schedules_due" ON "${JOB_SCHEDULES_TABLE}" ("status", "next_run_at", "id")`,
      );
    },
  },
];

export function ensureJobsSchema(ctx: DurableObjectState): void {
  const currentVersion = ctx.storage.kv.get<number>(JOBS_SCHEMA_VERSION_KEY) ?? -1;

  for (const migration of jobsSchemaMigrations) {
    if (migration.version <= currentVersion) continue;

    ctx.storage.transactionSync(() => {
      migration.up(ctx.storage);
      ctx.storage.kv.put(JOBS_SCHEMA_VERSION_KEY, migration.version);
    });
  }
}
