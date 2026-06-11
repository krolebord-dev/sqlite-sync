import type { SyncDbSchema } from "@sqlite-sync/core";
import { createSchemaDoc, type SchemaDocContext } from "./schema-doc";

export type AiDbExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

/**
 * Minimal executor contract for AI database access. Runtime-specific — inject the one that
 * matches where the storage lives; @sqlite-sync/cloudflare's `createKyselyExecutor` satisfies it.
 *
 * `transaction` MUST roll back everything the callback executed when the callback throws —
 * it backs the read-only enforcement of the query tooling.
 */
export type AiDbExecutor = {
  execute<TResult = unknown>(query: AiDbExecuteParams): { rows: TResult[] };
  transaction(callback: (tx: Pick<AiDbExecutor, "execute">) => void): void;
};

/**
 * Read-only AI access to a synced database. Lives where the storage lives; its method names
 * are the RPC contract, so a DO stub proxying to these methods exposes the same surface
 * (promise-wrapped) and satisfies the tool layer's `DbToolsAccess`.
 */
export type AiDbAccess = {
  getSchemaDoc(): string;
};

/**
 * Create where the CRDT storage was created (e.g. a Durable Object's `onStart`, after
 * migrations have run) — the schema doc is introspected once and cached.
 */
export function createAiDbAccess(opts: {
  executor: AiDbExecutor;
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext;
}): AiDbAccess {
  let schemaDoc: string | undefined;

  return {
    getSchemaDoc() {
      schemaDoc ??= createSchemaDoc({
        execute: (sql) => opts.executor.execute<Record<string, unknown>>({ sql, parameters: [] }).rows,
        syncDbSchema: opts.syncDbSchema,
        context: opts.context,
      });
      return schemaDoc;
    },
  };
}
