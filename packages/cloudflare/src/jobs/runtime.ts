import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type InternalDefinedJob, jobDefinitionInternals } from "./define-job";
import { ensureJobsSchema } from "./schema";
import {
  cancelIntervalSchedule,
  getDueQueuedJobs,
  insertOneOffJob,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  materializeDueSchedules,
  setNextAlarmFromDb,
  toJobRunRecord,
  upsertIntervalSchedule,
} from "./storage";
import type { AnyDefinedJob, JobRunResult, JobRuntime } from "./types";

type SetupJobsOptions<TContext extends Record<string, unknown>, TJobs extends readonly AnyDefinedJob[]> = {
  jobs: TJobs;
  ctx: DurableObjectState;
  context: TContext;
  maxJobsPerAlarm?: number;
};

type InternalJob = InternalDefinedJob<string, StandardSchemaV1>;

function getInternalJob(job: AnyDefinedJob): InternalJob {
  const internal = (job as InternalJob)[jobDefinitionInternals];
  if (!internal) {
    throw new Error(`Invalid job "${job.type}". Jobs must be created by defineJob(...).input(...).handler(...).`);
  }

  return job as InternalJob;
}

function validateMaxJobsPerAlarm(maxJobsPerAlarm: number): number {
  if (!Number.isFinite(maxJobsPerAlarm) || !Number.isInteger(maxJobsPerAlarm) || maxJobsPerAlarm < 1) {
    throw new Error(`Invalid "maxJobsPerAlarm". Expected a positive integer.`);
  }
  return maxJobsPerAlarm;
}

function requireRegisteredJob(jobsByType: Map<string, InternalJob>, job: AnyDefinedJob): InternalJob {
  const registered = jobsByType.get(job.type);
  if (!registered) {
    throw new Error(`Job type "${job.type}" is not registered. Pass it to setupJobs({ jobs: [...] }).`);
  }
  return registered;
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${label}. Expected a finite timestamp in milliseconds.`);
  }
  return Math.floor(value);
}

function normalizeIntervalMs(everyMs: number): number {
  if (!Number.isFinite(everyMs) || !Number.isInteger(everyMs) || everyMs < 1) {
    throw new Error(`Invalid "everyMs". Expected a positive integer number of milliseconds.`);
  }
  return everyMs;
}

async function parseJobInput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    const firstMessage = result.issues[0]?.message;
    throw new Error(
      firstMessage ? `Invalid "input". ${firstMessage}` : `Invalid "input". Payload does not match schema.`,
    );
  }

  return result.value;
}

async function validatePersistedInput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: StandardSchemaV1.InferOutput<TSchema>,
): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch (error) {
    throw new Error(`Invalid "input". Job payload must be JSON-serializable before persistence: ${String(error)}`);
  }

  if (serialized === undefined) {
    throw new Error(`Invalid "input". Job payload must serialize to JSON.`);
  }

  const roundTripped: unknown = JSON.parse(serialized);
  const result = await schema["~standard"].validate(roundTripped);
  if (result.issues) {
    throw new Error(`Invalid "input". Job payload must remain valid after JSON serialization for persisted jobs.`);
  }
}

function validateDedupeKey(dedupeKey: string): void {
  if (!dedupeKey || dedupeKey.trim().length === 0) {
    throw new Error(`Invalid "dedupeKey". Expected a non-empty string.`);
  }
}

export async function setupJobs<TContext extends Record<string, unknown>, TJobs extends readonly AnyDefinedJob[]>(
  options: SetupJobsOptions<TContext, TJobs>,
): Promise<JobRuntime> {
  const maxJobsPerAlarm = validateMaxJobsPerAlarm(options.maxJobsPerAlarm ?? 50);
  const jobsByType = new Map<string, InternalJob>();

  for (const job of options.jobs) {
    const internalJob = getInternalJob(job);
    if (jobsByType.has(job.type)) {
      throw new Error(`Duplicate job type "${job.type}" during setupJobs.`);
    }
    jobsByType.set(job.type, internalJob);
  }

  ensureJobsSchema(options.ctx);
  await setNextAlarmFromDb(options.ctx);

  const onAlarm = async (): Promise<JobRunResult> => {
    const now = Date.now();
    materializeDueSchedules(options.ctx, now);

    let processedJobs = 0;

    while (processedJobs < maxJobsPerAlarm) {
      const remaining = maxJobsPerAlarm - processedJobs;
      const dueJobs = getDueQueuedJobs(options.ctx, Date.now(), remaining);

      if (dueJobs.length === 0) {
        break;
      }

      for (const jobRow of dueJobs) {
        if (processedJobs >= maxJobsPerAlarm) {
          break;
        }

        const internalJob = jobsByType.get(jobRow.type);
        const startedAt = Date.now();
        markJobRunning(options.ctx, jobRow.id, startedAt);

        try {
          if (!internalJob) {
            throw new Error(`No registered handler for job type "${jobRow.type}".`);
          }

          const queuedRecord = toJobRunRecord(jobRow);
          const parsed = await internalJob[jobDefinitionInternals].schema["~standard"].validate(queuedRecord.payload);
          if (parsed.issues) {
            throw new Error(`Invalid persisted payload for job type "${jobRow.type}".`);
          }

          const input = parsed.value;
          const runningRecord = {
            ...queuedRecord,
            status: "running" as const,
            payload: input,
            startedAt,
            updatedAt: startedAt,
          };

          await internalJob[jobDefinitionInternals].handler({
            input,
            context: options.context,
            job: runningRecord,
          });

          markJobCompleted(options.ctx, jobRow.id, Date.now());
        } catch (error) {
          markJobFailed(options.ctx, jobRow.id, Date.now(), error);
        }

        processedJobs += 1;
      }
    }

    const nextAlarmAt = await setNextAlarmFromDb(options.ctx);
    return {
      processedJobs,
      nextAlarmAt,
    };
  };

  return {
    onAlarm,
    setNextAlarm: async () => setNextAlarmFromDb(options.ctx),

    schedule: (async (job, scheduleOptions) => {
      const registered = requireRegisteredJob(jobsByType, job);
      const schema = registered[jobDefinitionInternals].schema;
      const at = normalizeTimestamp(scheduleOptions.at, `"at"`);
      const input = await parseJobInput(schema, scheduleOptions.input);
      await validatePersistedInput(schema, input);

      const record = insertOneOffJob({
        ctx: options.ctx,
        type: job.type,
        input,
        at,
      });

      await setNextAlarmFromDb(options.ctx);
      return record;
    }) as JobRuntime["schedule"],

    scheduleInterval: (async (job, scheduleOptions) => {
      const registered = requireRegisteredJob(jobsByType, job);
      const schema = registered[jobDefinitionInternals].schema;
      validateDedupeKey(scheduleOptions.dedupeKey);
      const everyMs = normalizeIntervalMs(scheduleOptions.everyMs);
      const startAt = normalizeTimestamp(scheduleOptions.startAt ?? Date.now() + everyMs, `"startAt"`);
      const input = await parseJobInput(schema, scheduleOptions.input);
      await validatePersistedInput(schema, input);

      const record = upsertIntervalSchedule({
        ctx: options.ctx,
        type: job.type,
        dedupeKey: scheduleOptions.dedupeKey,
        input,
        everyMs,
        startAt,
      });

      await setNextAlarmFromDb(options.ctx);
      return record;
    }) as JobRuntime["scheduleInterval"],

    cancelInterval: (async (job, cancelOptions) => {
      requireRegisteredJob(jobsByType, job);
      validateDedupeKey(cancelOptions.dedupeKey);

      const cancelled = cancelIntervalSchedule({
        ctx: options.ctx,
        type: job.type,
        dedupeKey: cancelOptions.dedupeKey,
      });

      await setNextAlarmFromDb(options.ctx);
      return cancelled;
    }) as JobRuntime["cancelInterval"],
  };
}
