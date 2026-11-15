import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import type { SyncDbSchema } from "./crdt-schema";
import { concatSql, sqlStringLiteral } from "./make-crdt-table";

export type SnapshotCursor = {
  dataset: string;
  afterId: string;
};

export type SnapshotItem = {
  dataset: string;
  /**
   * The item's row in the base table, `id` and `tombstone` included, as a JSON object. SQLite
   * encodes it the way it encodes event payloads, so a value arrives as it would in an event.
   */
  row: string;
  /** The item's update log payload as stored: a JSON object of column to HLC. */
  updateLog: string;
};

export type SnapshotPullRequest = {
  /** `null` asks for the first page. */
  cursor: SnapshotCursor | null;
};

export type SnapshotPullResponse = {
  schemaVersion: number;
  /** The page reflects at least every event up to this sync id. */
  syncId: number;
  items: SnapshotItem[];
  /** `null` on the last page. */
  nextCursor: SnapshotCursor | null;
};

/**
 * How a remote answers a pull it will not serve from its event log: `required` when the log
 * no longer covers the requested range, `offered` when a snapshot is only the cheaper way in.
 */
export type SnapshotPullMode = "required" | "offered";

export type SnapshotProgress = {
  /** `syncId` of the first page, where the event log takes over once the snapshot is merged. */
  syncId: number;
  cursor: SnapshotCursor;
};

export type SnapshotPageLimits = {
  maxItems?: number;
  maxBytes?: number;
};

export const SNAPSHOT_PAGE_MAX_ITEMS = 1000;
export const SNAPSHOT_PAGE_MAX_BYTES = 1_000_000;

const READ_CHUNK_SIZE = 200;

export class SnapshotRequiredError extends Error {
  constructor(afterSyncId: number) {
    super(`Events after sync id ${afterSyncId} are only available as a snapshot`);
    this.name = "SnapshotRequiredError";
  }
}

/** Reads items in schema table order, then by id, so a cursor stays valid while rows change. */
export function createSnapshotPageReader({
  db,
  updateLogTable,
  schema,
}: {
  db: InternalSQLiteWrapper<any>;
  updateLogTable: string;
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig"> | undefined;
}) {
  const tables = (schema?.tablesConfig ?? []).flatMap((config) => {
    const table = schema?.tables[config.crdtTableName];
    if (!table) {
      return [];
    }
    const fields = Object.keys(table.columns).map(
      (column) => `${sqlStringLiteral(`${JSON.stringify(column)}:`)}||json_quote("item".${quoteId(column)})||','`,
    );
    const rowJson = concatSql(["'{'", `rtrim(${concatSql(fields)}, ',')`, "'}'"]);
    return [
      {
        dataset: config.baseTableName,
        sql: `select "item"."id" as "id", ${rowJson} as "row", "log"."payload" as "update_log"
from ${quoteId(config.baseTableName)} as "item"
join ${quoteId(updateLogTable)} as "log" on "log"."item_id" = "item"."id" and "log"."dataset" = ?
where "item"."id" > ?
order by "item"."id"
limit ?`,
      },
    ];
  });

  return (cursor: SnapshotCursor | null, limits: SnapshotPageLimits = {}) => {
    const maxItems = limits.maxItems ?? SNAPSHOT_PAGE_MAX_ITEMS;
    const maxBytes = limits.maxBytes ?? SNAPSHOT_PAGE_MAX_BYTES;

    let tableIndex = cursor ? tables.findIndex((table) => table.dataset === cursor.dataset) : 0;
    if (tableIndex === -1) {
      throw new Error(`Snapshot cursor points at an unknown dataset: ${cursor?.dataset}`);
    }
    let afterId = cursor?.afterId ?? "";

    const items: SnapshotItem[] = [];
    let bytes = 0;

    while (tableIndex < tables.length) {
      const table = tables[tableIndex];
      const limit = Math.min(READ_CHUNK_SIZE, maxItems - items.length);
      const rows = db.executePreparedRaw<[string, string, number], { id: string; row: string; update_log: string }>({
        key: `get-snapshot-page-${table.dataset}`,
        sql: table.sql,
        params: [table.dataset, afterId, limit],
        meta: { loggerLevel: "system" },
      });

      for (const { id, row, update_log: updateLog } of rows) {
        items.push({ dataset: table.dataset, row, updateLog });
        bytes += row.length + updateLog.length;
        afterId = id;
        if (items.length >= maxItems || bytes >= maxBytes) {
          return { items, nextCursor: { dataset: table.dataset, afterId } };
        }
      }

      if (rows.length < limit) {
        tableIndex++;
        afterId = "";
      }
    }

    return { items, nextCursor: null };
  };
}
