import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cancelIntervalSchedule, insertOneOffJob, setNextAlarmFromDb, upsertIntervalSchedule } from "./storage";
import type { DefinedJob, DefineJobBuilder, JobHandler } from "./types";

export const jobDefinitionInternals = Symbol.for("@sqlite-sync/cloudflare/jobs/definition");

type JobDefinitionInternals<TType extends string, TSchema extends StandardSchemaV1> = {
  schema: TSchema;
  handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, unknown, TType>;
};

export type InternalDefinedJob<TType extends string, TSchema extends StandardSchemaV1> = DefinedJob<TType, TSchema> & {
  [jobDefinitionInternals]: JobDefinitionInternals<TType, TSchema>;
};

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

export function defineJob<TType extends string>(options: { type: TType }): DefineJobBuilder<TType> {
  return {
    input: <TSchema extends StandardSchemaV1>(schema: TSchema) => ({
      handler: <TEnv>(handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, TEnv, TType>) => {
        const job: InternalDefinedJob<TType, TSchema> = {
          type: options.type,
          schedule: async (ctx, scheduleOptions) => {
            const at = normalizeTimestamp(scheduleOptions.at, `"at"`);
            const input = await parseJobInput(schema, scheduleOptions.input);
            await validatePersistedInput(schema, input);
            const record = insertOneOffJob({
              ctx,
              type: options.type,
              input,
              at,
            });

            await setNextAlarmFromDb(ctx);
            return record as typeof record & { type: TType };
          },
          scheduleInterval: async (ctx, scheduleOptions) => {
            validateDedupeKey(scheduleOptions.dedupeKey);
            const everyMs = normalizeIntervalMs(scheduleOptions.everyMs);
            const startAt = normalizeTimestamp(scheduleOptions.startAt ?? Date.now() + everyMs, `"startAt"`);
            const input = await parseJobInput(schema, scheduleOptions.input);
            await validatePersistedInput(schema, input);

            const record = upsertIntervalSchedule({
              ctx,
              type: options.type,
              dedupeKey: scheduleOptions.dedupeKey,
              input,
              everyMs,
              startAt,
            });

            await setNextAlarmFromDb(ctx);
            return record as typeof record & { type: TType };
          },
          cancelInterval: async (ctx, cancelOptions) => {
            validateDedupeKey(cancelOptions.dedupeKey);

            const cancelled = cancelIntervalSchedule({
              ctx,
              type: options.type,
              dedupeKey: cancelOptions.dedupeKey,
            });
            await setNextAlarmFromDb(ctx);
            return cancelled;
          },
          [jobDefinitionInternals]: {
            schema,
            handler: handler as JobHandler<StandardSchemaV1.InferOutput<TSchema>, unknown, TType>,
          },
        };

        return job;
      },
    }),
  };
}
