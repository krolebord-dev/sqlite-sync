import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type InternalDefinedJob, jobDefinitionInternals } from "./define-job";
import { ensureJobsSchema } from "./schema";
import {
  getDueQueuedJobs,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  materializeDueSchedules,
  setNextAlarmFromDb,
  toJobRunRecord,
} from "./storage";
import type { AnyDefinedJob, JobRunResult, JobRuntime } from "./types";

type SetupJobsOptions<TEnv, TJobs extends readonly AnyDefinedJob[]> = {
  jobs: TJobs;
  ctx: DurableObjectState;
  env: TEnv;
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

export async function setupJobs<TEnv, TJobs extends readonly AnyDefinedJob[]>(
  options: SetupJobsOptions<TEnv, TJobs>,
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
            ctx: options.ctx,
            env: options.env,
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
  };
}
