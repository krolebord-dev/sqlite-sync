import { jsonSchema, type ToolSet, tool } from "ai";
import type { AiQueryInput, AiQueryResult } from "./db-access";

type MaybePromise<T> = T | Promise<T>;

/**
 * What the tools need from the database side. Satisfied directly by `AiDbAccess`, or by a
 * Durable Object stub whose RPC methods delegate to one (RPC wraps returns in promises).
 */
export type DbToolsAccess = {
  getSchemaDoc(): MaybePromise<string>;
  query(input: AiQueryInput): MaybePromise<AiQueryResult>;
};

const emptyInputSchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const queryInputSchema = jsonSchema<{ sql: string; parameters?: unknown[] }>({
  type: "object",
  properties: {
    sql: {
      type: "string",
      description:
        "A single read-only SQLite statement starting with SELECT, WITH, or VALUES. Use ? placeholders for values.",
    },
    parameters: {
      type: "array",
      items: { type: ["string", "number", "boolean", "null"] },
      description: "Values bound to the ? placeholders, in order.",
    },
  },
  required: ["sql"],
  additionalProperties: false,
});

/**
 * AI SDK tools for a synced database. `access` is a factory because acquiring the database
 * may itself be async per call (e.g. resolving a Durable Object stub from another DO).
 */
export function createDbTools(opts: { access: () => MaybePromise<DbToolsAccess> }): ToolSet {
  return {
    getDbSchema: tool({
      description:
        "Get the schema documentation for the synced SQLite database: tables, columns, types, and data conventions. Call this before reasoning about the data.",
      inputSchema: emptyInputSchema,
      execute: async () => {
        const access = await opts.access();
        return await access.getSchemaDoc();
      },
    }),
    queryDb: tool({
      description:
        "Run a read-only SQL query against the synced SQLite database. Only a single SELECT/WITH/VALUES statement is allowed — anything that writes is rejected. Pass values as ? placeholders via `parameters` instead of inlining them as literals. Results are capped; ask for fewer columns or add LIMIT/WHERE if `truncated` is true.",
      inputSchema: queryInputSchema,
      execute: async ({ sql, parameters }) => {
        const access = await opts.access();
        return await access.query({ sql, parameters });
      },
    }),
  };
}
