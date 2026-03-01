import { JOB_SCHEDULES_TABLE, JOBS_TABLE } from "./schema";
import type { IntervalScheduleRecord, JobRunRecord } from "./types";

type JobRow = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  payload: string;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  error_message: string | null;
  error_stack: string | null;
  schedule_id: string | null;
  created_at: number;
  updated_at: number;
};

type ScheduleRow = {
  id: string;
  type: string;
  dedupe_key: string;
  payload: string;
  interval_ms: number;
  next_run_at: number;
  status: "active" | "cancelled";
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
};

function execute<TResult = unknown>(
  storage: DurableObjectStorage,
  sql: string,
  parameters: readonly unknown[] = [],
): TResult[] {
  return storage.sql.exec(sql, ...parameters).toArray() as TResult[];
}

function parsePayload(payload: string): unknown {
  return JSON.parse(payload);
}

export function toJobRunRecord<TType extends string = string, TInput = unknown>(
  row: JobRow,
): JobRunRecord<TType, TInput> {
  return {
    id: row.id,
    type: row.type as TType,
    status: row.status,
    payload: parsePayload(row.payload) as TInput,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    scheduleId: row.schedule_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIntervalScheduleRecord<TType extends string = string, TInput = unknown>(
  row: ScheduleRow,
): IntervalScheduleRecord<TType, TInput> {
  return {
    id: row.id,
    type: row.type as TType,
    dedupeKey: row.dedupe_key,
    payload: parsePayload(row.payload) as TInput,
    intervalMs: row.interval_ms,
    nextRunAt: row.next_run_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
  };
}

export function insertOneOffJob<TInput>({
  ctx,
  type,
  input,
  at,
}: {
  ctx: DurableObjectState;
  type: string;
  input: TInput;
  at: number;
}): JobRunRecord<string, TInput> {
  const now = Date.now();
  const row: JobRow = {
    id: crypto.randomUUID(),
    type,
    status: "queued",
    payload: JSON.stringify(input),
    scheduled_at: at,
    started_at: null,
    finished_at: null,
    error_message: null,
    error_stack: null,
    schedule_id: null,
    created_at: now,
    updated_at: now,
  };

  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `INSERT INTO "${JOBS_TABLE}" (
      "id",
      "type",
      "status",
      "payload",
      "scheduled_at",
      "started_at",
      "finished_at",
      "error_message",
      "error_stack",
      "schedule_id",
      "created_at",
      "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.type,
        row.status,
        row.payload,
        row.scheduled_at,
        row.started_at,
        row.finished_at,
        row.error_message,
        row.error_stack,
        row.schedule_id,
        row.created_at,
        row.updated_at,
      ],
    );
  });

  return toJobRunRecord<string, TInput>(row);
}

export function upsertIntervalSchedule<TInput>({
  ctx,
  type,
  dedupeKey,
  input,
  everyMs,
  startAt,
}: {
  ctx: DurableObjectState;
  type: string;
  dedupeKey: string;
  input: TInput;
  everyMs: number;
  startAt: number;
}): IntervalScheduleRecord<string, TInput> {
  const now = Date.now();
  const scheduleId = crypto.randomUUID();
  const payload = JSON.stringify(input);

  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `INSERT INTO "${JOB_SCHEDULES_TABLE}" (
        "id",
        "type",
        "dedupe_key",
        "payload",
        "interval_ms",
        "next_run_at",
        "status",
        "created_at",
        "updated_at",
        "last_run_at"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT ("type", "dedupe_key") DO UPDATE SET
        "payload" = excluded."payload",
        "interval_ms" = excluded."interval_ms",
        "next_run_at" = excluded."next_run_at",
        "status" = excluded."status",
        "updated_at" = excluded."updated_at"`,
      [scheduleId, type, dedupeKey, payload, everyMs, startAt, "active", now, now, null],
    );
  });

  const [row] = execute<ScheduleRow>(
    ctx.storage,
    `SELECT
      "id",
      "type",
      "dedupe_key",
      "payload",
      "interval_ms",
      "next_run_at",
      "status",
      "created_at",
      "updated_at",
      "last_run_at"
    FROM "${JOB_SCHEDULES_TABLE}"
    WHERE "type" = ? AND "dedupe_key" = ?
    LIMIT 1`,
    [type, dedupeKey],
  );

  if (!row) {
    throw new Error(`Failed to create schedule for job type "${type}"`);
  }

  return toIntervalScheduleRecord<string, TInput>(row);
}

export function cancelIntervalSchedule({
  ctx,
  type,
  dedupeKey,
}: {
  ctx: DurableObjectState;
  type: string;
  dedupeKey: string;
}): boolean {
  const [existing] = execute<Pick<ScheduleRow, "id">>(
    ctx.storage,
    `SELECT "id" FROM "${JOB_SCHEDULES_TABLE}"
    WHERE "type" = ? AND "dedupe_key" = ? AND "status" = 'active'
    LIMIT 1`,
    [type, dedupeKey],
  );

  if (!existing) {
    return false;
  }

  const now = Date.now();
  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `UPDATE "${JOB_SCHEDULES_TABLE}"
      SET "status" = 'cancelled', "updated_at" = ?
      WHERE "id" = ?`,
      [now, existing.id],
    );
  });

  return true;
}

export function materializeDueSchedules(ctx: DurableObjectState, now: number): number {
  let insertedJobs = 0;

  ctx.storage.transactionSync(() => {
    const dueSchedules = execute<ScheduleRow>(
      ctx.storage,
      `SELECT
        "id",
        "type",
        "dedupe_key",
        "payload",
        "interval_ms",
        "next_run_at",
        "status",
        "created_at",
        "updated_at",
        "last_run_at"
      FROM "${JOB_SCHEDULES_TABLE}"
      WHERE "status" = 'active' AND "next_run_at" <= ?
      ORDER BY "next_run_at" ASC, "id" ASC`,
      [now],
    );

    for (const schedule of dueSchedules) {
      const runId = crypto.randomUUID();
      execute(
        ctx.storage,
        `INSERT INTO "${JOBS_TABLE}" (
          "id",
          "type",
          "status",
          "payload",
          "scheduled_at",
          "started_at",
          "finished_at",
          "error_message",
          "error_stack",
          "schedule_id",
          "created_at",
          "updated_at"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          schedule.type,
          "queued",
          schedule.payload,
          schedule.next_run_at,
          null,
          null,
          null,
          null,
          schedule.id,
          now,
          now,
        ],
      );

      execute(
        ctx.storage,
        `UPDATE "${JOB_SCHEDULES_TABLE}"
        SET "last_run_at" = ?, "next_run_at" = ?, "updated_at" = ?
        WHERE "id" = ?`,
        [now, now + schedule.interval_ms, now, schedule.id],
      );

      insertedJobs += 1;
    }
  });

  return insertedJobs;
}

export function getDueQueuedJobs(ctx: DurableObjectState, now: number, limit: number): JobRow[] {
  return execute<JobRow>(
    ctx.storage,
    `SELECT
      "id",
      "type",
      "status",
      "payload",
      "scheduled_at",
      "started_at",
      "finished_at",
      "error_message",
      "error_stack",
      "schedule_id",
      "created_at",
      "updated_at"
    FROM "${JOBS_TABLE}"
    WHERE "status" = 'queued' AND "scheduled_at" <= ?
    ORDER BY "scheduled_at" ASC, "id" ASC
    LIMIT ?`,
    [now, limit],
  );
}

export function markJobRunning(ctx: DurableObjectState, jobId: string, startedAt: number): void {
  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `UPDATE "${JOBS_TABLE}"
      SET "status" = 'running', "started_at" = ?, "updated_at" = ?
      WHERE "id" = ?`,
      [startedAt, startedAt, jobId],
    );
  });
}

export function markJobCompleted(ctx: DurableObjectState, jobId: string, finishedAt: number): void {
  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `UPDATE "${JOBS_TABLE}"
      SET
        "status" = 'completed',
        "finished_at" = ?,
        "updated_at" = ?,
        "error_message" = NULL,
        "error_stack" = NULL
      WHERE "id" = ?`,
      [finishedAt, finishedAt, jobId],
    );
  });
}

function toErrorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  return {
    message: String(error),
    stack: null,
  };
}

export function markJobFailed(ctx: DurableObjectState, jobId: string, finishedAt: number, error: unknown): void {
  const details = toErrorDetails(error);

  ctx.storage.transactionSync(() => {
    execute(
      ctx.storage,
      `UPDATE "${JOBS_TABLE}"
      SET
        "status" = 'failed',
        "finished_at" = ?,
        "updated_at" = ?,
        "error_message" = ?,
        "error_stack" = ?
      WHERE "id" = ?`,
      [finishedAt, finishedAt, details.message, details.stack, jobId],
    );
  });
}

export async function setNextAlarmFromDb(ctx: DurableObjectState): Promise<number | null> {
  const [jobRow] = execute<{ next_at: number | null }>(
    ctx.storage,
    `SELECT MIN("scheduled_at") AS "next_at"
    FROM "${JOBS_TABLE}"
    WHERE "status" = 'queued'`,
  );
  const [scheduleRow] = execute<{ next_at: number | null }>(
    ctx.storage,
    `SELECT MIN("next_run_at") AS "next_at"
    FROM "${JOB_SCHEDULES_TABLE}"
    WHERE "status" = 'active'`,
  );

  const nextJobAt = jobRow?.next_at ?? null;
  const nextScheduleAt = scheduleRow?.next_at ?? null;

  let nextAlarmAt: number | null = null;
  if (nextJobAt !== null && nextScheduleAt !== null) {
    nextAlarmAt = Math.min(nextJobAt, nextScheduleAt);
  } else if (nextJobAt !== null) {
    nextAlarmAt = nextJobAt;
  } else if (nextScheduleAt !== null) {
    nextAlarmAt = nextScheduleAt;
  }

  if (nextAlarmAt === null) {
    await ctx.storage.deleteAlarm();
    return null;
  }

  await ctx.storage.setAlarm(nextAlarmAt);
  return nextAlarmAt;
}

export type { JobRow };
