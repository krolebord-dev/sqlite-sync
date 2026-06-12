import type { SyncDbSchema } from "@sqlite-sync/core";
import { createQueryGuard, QueryGuardError } from "./query-guard";
import { createSchemaDoc, type SchemaDocContext } from "./schema-doc";

export type AiDbExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

/**
 * Minimal executor contract for AI database access. Runtime-specific — inject the one that
 * matches where the storage lives; @sqlite-sync/cloudflare's `createKyselyExecutor` satisfies it.
 */
export type AiDbExecutor = {
  execute<TResult = unknown>(query: AiDbExecuteParams): { rows: TResult[] };
  transaction(callback: (tx: Pick<AiDbExecutor, "execute">) => void): void;
};

export type AiQueryInput = {
  sql: string;
  parameters?: readonly unknown[];
};

export type AiQueryResult =
  | {
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
    }
  | {
      error: string;
    };

/**
 * Read-only AI access to a synced database. Lives where the storage lives; its method names
 * are the RPC contract, so a DO stub proxying to these methods exposes the same surface
 * (promise-wrapped) and satisfies the tool layer's `DbToolsAccess`.
 *
 * `query` enforces read-only (single SELECT/WITH/VALUES statement, no write opcodes, executed
 * in a forced-rollback transaction) but reads are not restricted by table — the whole database
 * file is in scope for the agent, so don't colocate data the agent must not see.
 */
export type AiDbAccess = {
  getSchemaDoc(): string;
  query(input: AiQueryInput): AiQueryResult;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function createAiDbAccess(opts: {
  executor: AiDbExecutor;
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext;
  limits?: { maxRows?: number; maxCellChars?: number };
}): AiDbAccess {
  const schemaDoc = createSchemaDoc({ syncDbSchema: opts.syncDbSchema, context: opts.context });
  const guard = createQueryGuard({ executor: opts.executor });
  const maxRows = opts.limits?.maxRows ?? 200;
  const maxCellChars = opts.limits?.maxCellChars ?? 2000;

  return {
    getSchemaDoc() {
      return schemaDoc;
    },
    query(input) {
      let resultRows: Record<string, unknown>[];
      try {
        resultRows = guard.execute<Record<string, unknown>>(input).rows;
      } catch (error) {
        if (error instanceof QueryGuardError) {
          return { error: error.message };
        }
        throw error;
      }

      let truncated = resultRows.length > maxRows;

      function shapeCell(value: unknown): unknown {
        if (value instanceof Uint8Array) {
          // Base64 inflates by 4/3, so budget the encoded length against the cell cap.
          if (Math.ceil(value.byteLength / 3) * 4 <= maxCellChars) {
            return `<blob base64 ${toBase64(value)}>`;
          }
          truncated = true;
          return `<blob ${value.byteLength} bytes>`;
        }
        if (typeof value === "string" && value.length > maxCellChars) {
          truncated = true;
          return `${value.slice(0, maxCellChars)}…`;
        }
        return value;
      }

      const rows = resultRows
        .slice(0, maxRows)
        .map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, shapeCell(value)])));

      return { rows, rowCount: resultRows.length, truncated };
    },
  };
}
