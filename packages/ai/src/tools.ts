import { type JSONSchema7, jsonSchema, type Schema, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { AiMutationInput, AiMutationResult, AiQueryInput, AiQueryResult } from "./db-access";
import {
  type DbToolsAccess,
  getDbSchemaDescription,
  getDbSchemaInputSchema,
  mutateDbDescription,
  mutateDbInputSchema,
  mutationsDisabledResult,
  queryDbDescription,
  queryDbInputSchema,
} from "./tool-definitions";

type MaybePromise<T> = T | Promise<T>;

export type CreateDbToolsOptions = {
  access: () => MaybePromise<DbToolsAccess>;
  /** Expose the write-capable `mutateDb` tool. The access object must also implement `mutate`. */
  mutations?: boolean;
};

/**
 * Passing zod schemas to the AI SDK directly would set `additionalProperties: false` on every
 * object, which advertises record payloads as empty. The schemas only describe inputs to the
 * model: validation is left to the access layer, whose errors are clearer for models than zod's.
 */
function toAiSdkSchema<T>(schema: z.ZodType<T>): Schema<T> {
  return jsonSchema<T>(z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as JSONSchema7);
}

const getDbSchemaToolInput = toAiSdkSchema<Record<string, never>>(getDbSchemaInputSchema);
const queryDbToolInput = toAiSdkSchema<AiQueryInput>(queryDbInputSchema);
const mutateDbToolInput = toAiSdkSchema<AiMutationInput>(mutateDbInputSchema);

/**
 * AI SDK tools for a synced database. `access` is a factory because acquiring the database
 * may itself be async per call (e.g. resolving a Durable Object stub from another DO).
 */
export function createDbTools(opts: CreateDbToolsOptions): ToolSet {
  const tools: ToolSet = {
    getDbSchema: tool({
      description: getDbSchemaDescription,
      inputSchema: getDbSchemaToolInput,
      execute: async () => {
        const access = await opts.access();
        return await access.getSchemaDoc();
      },
    }),
    queryDb: tool({
      description: queryDbDescription,
      inputSchema: queryDbToolInput,
      execute: async (input): Promise<AiQueryResult> => {
        const access = await opts.access();
        return await access.query(input);
      },
    }),
  };

  if (opts.mutations) {
    tools.mutateDb = tool({
      description: mutateDbDescription,
      inputSchema: mutateDbToolInput,
      execute: async (input): Promise<AiMutationResult> => {
        const access = await opts.access();
        if (!access.mutate) {
          return mutationsDisabledResult;
        }
        return await access.mutate(input);
      },
    });
  }

  return tools;
}
