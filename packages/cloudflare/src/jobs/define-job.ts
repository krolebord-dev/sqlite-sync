import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CreateDefineJobBuilder, DefinedJob, DefineJobBuilder, DefineJobInputBuilder, JobHandler } from "./types";

export const jobDefinitionInternals = Symbol.for("@sqlite-sync/cloudflare/jobs/definition");

type JobDefinitionInternals<TType extends string, TSchema extends StandardSchemaV1> = {
  schema: TSchema;
  handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, Record<string, unknown>, TType>;
};

export type InternalDefinedJob<TType extends string, TSchema extends StandardSchemaV1> = DefinedJob<
  TType,
  TSchema,
  Record<string, unknown>
> & {
  [jobDefinitionInternals]: JobDefinitionInternals<TType, TSchema>;
};

export function createDefineJob<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(): CreateDefineJobBuilder<TContext> {
  return function defineJob<TType extends string>(options: { type: TType }): DefineJobBuilder<TType, TContext> {
    return {
      input: <TSchema extends StandardSchemaV1>(schema: TSchema): DefineJobInputBuilder<TType, TSchema, TContext> => ({
        handler: (handler: JobHandler<StandardSchemaV1.InferOutput<TSchema>, TContext, TType>) => {
          const job: InternalDefinedJob<TType, TSchema> = {
            type: options.type,
            [jobDefinitionInternals]: {
              schema,
              handler: handler as JobHandler<StandardSchemaV1.InferOutput<TSchema>, Record<string, unknown>, TType>,
            },
          };
          return job as DefinedJob<TType, TSchema, TContext>;
        },
      }),
    };
  };
}
