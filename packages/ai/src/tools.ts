import { jsonSchema, type ToolSet, tool } from "ai";
import type { AiMutationInput, AiMutationResult, AiQueryInput, AiQueryResult } from "./db-access";

type MaybePromise<T> = T | Promise<T>;

/**
 * What the tools need from the database side. Satisfied directly by `AiDbAccess`, or by a
 * Durable Object stub whose RPC methods delegate to one (RPC wraps returns in promises).
 */
export type DbToolsAccess = {
  getSchemaDoc(): MaybePromise<string>;
  query(input: AiQueryInput): MaybePromise<AiQueryResult>;
  mutate?(input: AiMutationInput): MaybePromise<AiMutationResult>;
};

export type CreateDbToolsOptions = {
  access: () => MaybePromise<DbToolsAccess>;
  /** Expose the write-capable `mutateDb` tool. The access object must also implement `mutate`. */
  mutations?: boolean;
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

const mutationInputSchema = jsonSchema<AiMutationInput>({
  type: "object",
  properties: {
    events: {
      type: "array",
      minItems: 1,
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["item-created"],
                description: "Create a synced row. Omit item_id and payload.id; the tool generates the id.",
              },
              dataset: {
                type: "string",
                description: "The synced dataset/table name from the schema documentation.",
              },
              payload: {
                type: "object",
                additionalProperties: true,
                not: { required: ["id"] },
                description:
                  "Column values for the new row, excluding id. Include all required non-id columns from the schema.",
              },
            },
            required: ["type", "dataset", "payload"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["item-updated", "item-deleted"],
                description: "Update or delete an existing synced row.",
              },
              dataset: {
                type: "string",
                description: "The synced dataset/table name from the schema documentation.",
              },
              item_id: {
                type: "string",
                description: "The stable id of the row being updated or deleted.",
              },
              payload: {
                type: "object",
                additionalProperties: true,
                description: "Changed column values for item-updated. Omit or pass {} for item-deleted.",
              },
            },
            required: ["type", "dataset", "item_id"],
            additionalProperties: false,
          },
        ],
      },
      description: "One or more CRDT mutation events to apply atomically.",
    },
  },
  required: ["events"],
  additionalProperties: false,
});

/**
 * AI SDK tools for a synced database. `access` is a factory because acquiring the database
 * may itself be async per call (e.g. resolving a Durable Object stub from another DO).
 */
export function createDbTools(opts: CreateDbToolsOptions): ToolSet {
  const tools: ToolSet = {
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
        "Run a read-only SQL query against the synced SQLite database. Only a single SELECT/WITH/VALUES statement is allowed. Anything that writes is rejected. Pass values as ? placeholders via `parameters` instead of inlining them as literals. Results are capped; ask for fewer columns or add LIMIT/WHERE if `truncated` is true.",
      inputSchema: queryInputSchema,
      execute: async ({ sql, parameters }) => {
        const access = await opts.access();
        return await access.query({ sql, parameters });
      },
    }),
  };

  if (opts.mutations) {
    tools.mutateDb = tool({
      description:
        "Apply one or more CRDT mutation events to the synced database. Use this for writes instead of SQL. Query the current data first when updating or deleting existing rows. Create events must omit ids: do not provide item_id or payload.id, because the tool generates ids and returns them. Create payloads must include all required non-id columns, update events should include only changed columns, and delete events should use an empty payload. Tables the schema documentation marks read-only cannot be written.",
      inputSchema: mutationInputSchema,
      execute: async (input) => {
        const access = await opts.access();
        if (!access.mutate) {
          return { error: "Database mutations are not enabled for this access object." } satisfies AiMutationResult;
        }
        return await access.mutate(input);
      },
    });
  }

  return tools;
}
