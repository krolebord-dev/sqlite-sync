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
  schedule: <TType extends string, TSchema extends StandardSchemaV1>(
    job: DefinedJob<TType, TSchema>,
    options: JobScheduleOptions<StandardSchemaV1.InferOutput<TSchema>>,
  ) => Promise<JobRunRecord<TType, StandardSchemaV1.InferOutput<TSchema>>>;
  scheduleInterval: <TType extends string, TSchema extends StandardSchemaV1>(
    job: DefinedJob<TType, TSchema>,
    options: IntervalJobScheduleOptions<StandardSchemaV1.InferOutput<TSchema>>,
  ) => Promise<IntervalScheduleRecord<TType, StandardSchemaV1.InferOutput<TSchema>>>;
  cancelInterval: <TType extends string, TSchema extends StandardSchemaV1>(
    job: DefinedJob<TType, TSchema>,
    options: CancelIntervalJobOptions,
  ) => Promise<boolean>;
};

export type JobExecutionContext<TInput, TContext extends Record<string, unknown>, TType extends string> = {
  input: TInput;
  context: TContext;
  job: JobRunRecord<TType, TInput>;
};

export type JobHandler<TInput, TContext extends Record<string, unknown>, TType extends string> = (
  context: JobExecutionContext<TInput, TContext, TType>,
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

export type DefinedJob<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = {
  type: TType;
  /** @internal Phantom field for type inference — never set at runtime. */
  readonly "~schema"?: TSchema;
  /** @internal Phantom field for type inference — never set at runtime. */
  readonly "~context"?: TContext;
};

export type AnyDefinedJob = DefinedJob<string, StandardSchemaV1, Record<string, unknown>>;

export type DefineJobInputBuilder<
  TType extends string,
  TSchema extends StandardSchemaV1,
  TContext extends Record<string, unknown>,
> = {
  handler: (
    handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, TContext, TType>,
  ) => DefinedJob<TType, TSchema, TContext>;
};

export type DefineJobBuilder<TType extends string, TContext extends Record<string, unknown>> = {
  input: <TSchema extends StandardSchemaV1>(schema: TSchema) => DefineJobInputBuilder<TType, TSchema, TContext>;
};

export type CreateDefineJobBuilder<TContext extends Record<string, unknown>> = <TType extends string>(options: {
  type: TType;
}) => DefineJobBuilder<TType, TContext>;
