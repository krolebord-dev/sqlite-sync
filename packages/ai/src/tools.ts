import { jsonSchema, type ToolSet, tool } from "ai";

type MaybePromise<T> = T | Promise<T>;

/**
 * What the tools need from the database side. Satisfied directly by `AiDbAccess`, or by a
 * Durable Object stub whose RPC methods delegate to one (RPC wraps returns in promises).
 */
export type DbToolsAccess = {
  getSchemaDoc(): MaybePromise<string>;
};

const emptyInputSchema = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
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
  };
}
