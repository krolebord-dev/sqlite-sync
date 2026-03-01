import type { StandardSchemaV1 } from "@standard-schema/spec";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type JobRunRecord<TType extends string = string, TInput = unknown> = {
  id: string;
  type: TType;
  status: JobStatus;
  payload: TInput;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  scheduleId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type IntervalScheduleStatus = "active" | "cancelled";

export type IntervalScheduleRecord<TType extends string = string, TInput = unknown> = {
  id: string;
  type: TType;
  dedupeKey: string;
  payload: TInput;
  intervalMs: number;
  nextRunAt: number;
  status: IntervalScheduleStatus;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
};

export type JobRunResult = {
  processedJobs: number;
  nextAlarmAt: number | null;
};

export type JobRuntime = {
  onAlarm: () => Promise<JobRunResult>;
  setNextAlarm: () => Promise<number | null>;
};

export type JobExecutionContext<TInput, TEnv, TType extends string> = {
  input: TInput;
  ctx: DurableObjectState;
  env: TEnv;
  job: JobRunRecord<TType, TInput>;
};

export type JobHandler<TInput, TEnv, TType extends string> = (
  context: JobExecutionContext<TInput, TEnv, TType>,
) => void | Promise<void>;

export type JobScheduleOptions<TInput> = {
  input: TInput;
  at: number;
};

export type IntervalJobScheduleOptions<TInput> = {
  input: TInput;
  dedupeKey: string;
  everyMs: number;
  startAt?: number;
};

export type CancelIntervalJobOptions = {
  dedupeKey: string;
};

export type DefinedJob<TType extends string, TSchema extends StandardSchemaV1> = {
  type: TType;
  schedule: (
    ctx: DurableObjectState,
    options: JobScheduleOptions<StandardSchemaV1.InferOutput<TSchema>>,
  ) => Promise<JobRunRecord<TType, StandardSchemaV1.InferOutput<TSchema>>>;
  scheduleInterval: (
    ctx: DurableObjectState,
    options: IntervalJobScheduleOptions<StandardSchemaV1.InferOutput<TSchema>>,
  ) => Promise<IntervalScheduleRecord<TType, StandardSchemaV1.InferOutput<TSchema>>>;
  cancelInterval: (ctx: DurableObjectState, options: CancelIntervalJobOptions) => Promise<boolean>;
};

export type AnyDefinedJob = DefinedJob<string, StandardSchemaV1>;

export type DefineJobInputBuilder<TType extends string, TSchema extends StandardSchemaV1> = {
  handler: <TEnv>(
    handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, TEnv, TType>,
  ) => DefinedJob<TType, TSchema>;
};

export type DefineJobBuilder<TType extends string> = {
  input: <TSchema extends StandardSchemaV1>(schema: TSchema) => DefineJobInputBuilder<TType, TSchema>;
};
