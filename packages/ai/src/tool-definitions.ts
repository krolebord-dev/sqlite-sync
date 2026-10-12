import { z } from "zod";
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

export const getDbSchemaDescription =
  "Get the schema documentation for the synced SQLite database: tables, columns, types, and data conventions. Call this before reasoning about the data.";

export const queryDbDescription =
  "Run a read-only SQL query against the synced SQLite database. Only a single SELECT/WITH/VALUES statement is allowed. Anything that writes is rejected. Pass values as ? placeholders via `parameters` instead of inlining them as literals. Results are capped; ask for fewer columns or add LIMIT/WHERE if `truncated` is true.";

export const mutateDbDescription =
  "Apply one or more CRDT mutation events to the synced database. Use this for writes instead of SQL. Query the current data first when updating or deleting existing rows. Create events must omit ids: do not provide item_id or payload.id, because the tool generates ids and returns them. Create payloads must include all required non-id columns, update events should include only changed columns, and delete events should use an empty payload. Tables the schema documentation marks read-only cannot be written.";

export const mutationsDisabledResult = {
  error: "Database mutations are not enabled for this access object.",
} satisfies AiMutationResult;

export const getDbSchemaInputSchema = z.strictObject({});

export const queryDbInputSchema = z.strictObject({
  sql: z
    .string()
    .describe(
      "A single read-only SQLite statement starting with SELECT, WITH, or VALUES. Use ? placeholders for values.",
    ),
  parameters: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Values bound to the ? placeholders, in order."),
});

const datasetSchema = z.string().describe("The synced dataset/table name from the schema documentation.");

const createEventSchema = z.strictObject({
  type: z
    .literal("item-created")
    .describe("Create a synced row. Omit item_id and payload.id; the tool generates the id."),
  dataset: datasetSchema,
  payload: z.record(z.string(), z.unknown()).meta({
    description: "Column values for the new row, excluding id. Include all required non-id columns from the schema.",
    not: { required: ["id"] },
  }),
});

const changeEventSchema = z.strictObject({
  type: z.enum(["item-updated", "item-deleted"]).describe("Update or delete an existing synced row."),
  dataset: datasetSchema,
  item_id: z.string().describe("The stable id of the row being updated or deleted."),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Changed column values for item-updated. Omit or pass {} for item-deleted."),
});

export const mutateDbInputSchema = z.strictObject({
  events: z
    .array(z.union([createEventSchema, changeEventSchema]))
    .min(1)
    .describe("One or more CRDT mutation events to apply atomically."),
});
