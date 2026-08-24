import {
  type CrdtEventType,
  CrdtEventValidationError,
  type CrdtStorage,
  generateId,
  type OwnCrdtEvent,
  type SyncDbSchema,
} from "@sqlite-sync/core";
import { resolveAiPolicy } from "./policy";
import { createQueryGuard, QueryGuardError } from "./query-guard";
import { createSchemaDoc, type SchemaDocContext } from "./schema-doc";

export type AiDbExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

/**
 * Minimal executor contract for AI database access. Inject the raw SQL capability that
 * matches where the storage lives. A Cloudflare `ServerSyncDb`'s `unsafe` executor satisfies it.
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

export type AiMutationEvent =
  | {
      type: "item-created";
      dataset: string;
      item_id?: never;
      payload?: Record<string, unknown>;
    }
  | {
      type: Exclude<CrdtEventType, "item-created">;
      dataset: string;
      item_id: string;
      payload?: Record<string, unknown>;
    };

export type AiMutationInput = {
  events: AiMutationEvent[];
};

export type AiMutationResult =
  | {
      applied: true;
      eventCount: number;
      createdIds: string[];
    }
  | {
      error: string;
      errors?: string[];
    };

/**
 * AI access to a synced database. Lives next to the storage. Method names are the RPC
 * contract: a DO stub that proxies them (promise-wrapped) satisfies `DbToolsAccess`.
 *
 * `query` is read-only: one SELECT/WITH/VALUES statement, no write opcodes, run in a
 * forced-rollback transaction. Table-level read limits apply only after the schema sets
 * `{ ai: "hidden" }` on a table. Until then the whole database file is in scope, so do not
 * put secret data in the same file.
 *
 * `mutate` exists only when `createAiDbAccess` gets a CRDT storage. Mutations are CRDT
 * events on the normal own-event path, never direct SQL writes. Tables marked read-only or
 * hidden are rejected.
 */
export type AiDbAccess = {
  getSchemaDoc(): string;
  query(input: AiQueryInput): AiQueryResult;
  mutate?(input: AiMutationInput): AiMutationResult;
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
  storage?: Pick<CrdtStorage, "applyOwnEvents">;
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext;
  limits?: { maxRows?: number; maxCellChars?: number };
}): AiDbAccess {
  const policy = resolveAiPolicy({ syncDbSchema: opts.syncDbSchema });
  const schemaDoc = createSchemaDoc({ syncDbSchema: opts.syncDbSchema, context: opts.context });
  // A hidden table flips reads to an allow-list, which also cuts off the event log (it holds
  // every dataset's payloads) and any non-synced table sharing the database file.
  const guard = createQueryGuard({
    executor: opts.executor,
    readableTables: policy.hasHiddenTables ? policy.readableBaseTableNames : undefined,
  });
  const maxRows = opts.limits?.maxRows ?? 200;
  const maxCellChars = opts.limits?.maxCellChars ?? 2000;

  const access: AiDbAccess = {
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

  const storage = opts.storage;
  if (storage) {
    access.mutate = (input) => {
      const errors: string[] = [];
      const createdIds: string[] = [];
      const events: OwnCrdtEvent[] = [];

      for (const [index, event] of input.events.entries()) {
        const tableAccess = policy.tableAccess(event.dataset);
        if (tableAccess === "hidden") {
          errors.push(`[${index}] unknown or unavailable dataset "${event.dataset}"`);
          continue;
        }
        if (tableAccess === "read-only") {
          errors.push(`[${index}] dataset "${event.dataset}" is read-only and cannot be modified`);
          continue;
        }
        if (event.type === "item-created") {
          const looseEvent = event as { item_id?: unknown };
          const payload = event.payload ?? {};
          if (looseEvent.item_id !== undefined) {
            errors.push(`[${index}] item-created events must omit item_id; an id is generated automatically`);
          }
          if ("id" in payload) {
            errors.push(`[${index}] item-created payload must omit id; an id is generated automatically`);
          }
          if (looseEvent.item_id !== undefined || "id" in payload) {
            continue;
          }

          const id = generateId();
          createdIds.push(id);
          events.push({
            type: "item-created",
            dataset: event.dataset,
            item_id: id,
            payload: JSON.stringify({ ...payload, id }),
          });
          continue;
        }

        events.push({
          type: event.type,
          dataset: event.dataset,
          item_id: event.item_id,
          payload: JSON.stringify(event.payload ?? {}),
        });
      }

      if (errors.length > 0) {
        return { error: `Invalid mutation events: ${errors.join("; ")}`, errors };
      }

      try {
        storage.applyOwnEvents(events);
      } catch (error) {
        if (error instanceof CrdtEventValidationError) {
          return { error: error.message, errors: error.errors };
        }
        throw error;
      }

      return { applied: true, eventCount: events.length, createdIds };
    };
  }

  return access;
}
