import { xxhash } from "../hash";
import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import type { SyncDbSchema } from "./crdt-schema";
import type { CrdtUpdateLogItem, CrdtUpdateLogPayload } from "./crdt-table-schema";

const STATE_HASH_PATTERN = /^(-?\d+):([0-9a-f]{16})$/;

/**
 * Persistence for the state hash. Reads and writes must go through the same
 * transaction that changes the update log, so a rollback reverts both.
 */
export type StateHashStore = {
  read: () => string | null;
  write: (value: string) => void;
};

export function formatStateHash(schemaVersion: number, sum: bigint) {
  return `${schemaVersion}:${sum.toString(16).padStart(16, "0")}`;
}

export function parseStateHash(value: string | null | undefined) {
  const match = value ? STATE_HASH_PATTERN.exec(value) : null;
  if (!match) {
    return null;
  }
  return { schemaVersion: Number(match[1]), sum: BigInt(`0x${match[2]}`) };
}

/** Returns the hashed columns for a dataset, or null to hash whichever cells the update log holds. */
export type StateHashColumns = (dataset: string) => readonly string[] | null;

export type StateHashAccumulator = ReturnType<typeof createStateHashAccumulator>;

/**
 * The state hash is a sum of per-cell hashes over the CRDT update log, tagged with
 * the schema version it was computed for. It depends only on current state, not on
 * history, so replicas that converged agree on it no matter how they got there.
 *
 * Cells are the dataset's schema columns except `id`. A cell missing from the
 * update log hashes as written by the item's latest create (the HLC stored under
 * `id`). Older builds filled column defaults into creates migrated through an
 * add-column migration, so replicas that replayed history hold such cells while
 * replicas that applied the creates earlier never stored them.
 */
export function createStateHashAccumulator({ sum, getColumns }: { sum: bigint; getColumns: StateHashColumns }) {
  let current = sum;

  const cellHash = (dataset: string, itemId: string, column: string, hlc: string) =>
    xxhash.h64(`${dataset}\u0000${itemId}\u0000${column}\u0000${hlc}`);

  const columnsOf = (dataset: string, meta: CrdtUpdateLogPayload) =>
    getColumns(dataset) ?? Object.keys(meta).filter((column) => column !== "id");

  return {
    get sum() {
      return current;
    },
    addItem(dataset: string, itemId: string, meta: CrdtUpdateLogPayload) {
      const createHlc = meta.id ?? "";
      for (const column of columnsOf(dataset, meta)) {
        current = BigInt.asUintN(64, current + cellHash(dataset, itemId, column, meta[column] ?? createHlc));
      }
    },
    /**
     * `meta` is the item's update log after the write. `replacedCells` holds each written
     * cell's HLC from before it, and `previousCreateHlc` the item's create HLC from before.
     */
    updateItem(
      dataset: string,
      itemId: string,
      meta: CrdtUpdateLogPayload,
      previousCreateHlc: string | undefined,
      replacedCells: readonly [column: string, previousHlc: string | undefined][],
    ) {
      const columns = getColumns(dataset);
      for (const [column, previousHlc] of replacedCells) {
        if (columns ? !columns.includes(column) : column === "id") {
          continue;
        }
        const previous = previousHlc ?? (columns ? (previousCreateHlc ?? "") : undefined);
        if (previous !== undefined) {
          current = BigInt.asUintN(64, current - cellHash(dataset, itemId, column, previous));
        }
        current = BigInt.asUintN(64, current + cellHash(dataset, itemId, column, meta[column]));
      }

      if (!columns || meta.id === previousCreateHlc) {
        return;
      }
      for (const column of columns) {
        if (meta[column] === undefined) {
          current = BigInt.asUintN(
            64,
            current -
              cellHash(dataset, itemId, column, previousCreateHlc ?? "") +
              cellHash(dataset, itemId, column, meta.id ?? ""),
          );
        }
      }
    },
  };
}

export type StateHashTracker = ReturnType<typeof createStateHashTracker>;

/** Keeps the stored state hash in step with the update log. Without a store it does nothing. */
export function createStateHashTracker({
  db,
  updateLogTable,
  schema,
  getSchemaVersion,
  store,
}: {
  db: InternalSQLiteWrapper<any>;
  updateLogTable: string;
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig"> | undefined;
  getSchemaVersion: () => number;
  store: StateHashStore | null;
}) {
  const columnsByDataset = new Map(
    (schema?.tablesConfig ?? []).flatMap((config) => {
      const table = schema?.tables[config.crdtTableName];
      return table ? [[config.baseTableName, Object.keys(table.columns).filter((column) => column !== "id")]] : [];
    }),
  );
  const getColumns = (dataset: string) => columnsByDataset.get(dataset) ?? null;
  let active: StateHashAccumulator | null = null;

  const rebuild = () => {
    const accumulator = createStateHashAccumulator({ sum: 0n, getColumns });
    const batchSize = 1000;
    let after: [string, string] = ["", ""];
    for (;;) {
      const rows = db.executePreparedRaw<[string, string, number], CrdtUpdateLogItem>({
        key: "get-update-log-batch",
        sql: `select "dataset", "item_id", "payload" from ${quoteId(updateLogTable)}
where ("item_id", "dataset") > (?, ?)
order by "item_id", "dataset"
limit ?`,
        params: [...after, batchSize],
        meta: { loggerLevel: "system" },
      });

      for (const row of rows) {
        accumulator.addItem(row.dataset, row.item_id, JSON.parse(row.payload));
      }

      const lastRow = rows[rows.length - 1];
      if (!lastRow || rows.length < batchSize) {
        break;
      }
      after = [lastRow.item_id, lastRow.dataset];
    }
    return accumulator.sum;
  };

  // Hashes computed for another schema version cover a different set of columns,
  // and migrations rewrite the update log directly, so those are rebuilt.
  const readSum = (store: StateHashStore) => {
    const stored = parseStateHash(store.read());
    if (stored && stored.schemaVersion === getSchemaVersion()) {
      return stored.sum;
    }
    const sum = rebuild();
    store.write(formatStateHash(getSchemaVersion(), sum));
    return sum;
  };

  return {
    /** The accumulator of the running `track` call, for apply functions to add cells to. */
    get active() {
      return active;
    },
    read: () => store?.read() ?? null,
    /** Rebuilds a missing or outdated hash. Must run inside a transaction. */
    initialize: () => {
      if (store) {
        readSum(store);
      }
    },
    /** Must run inside the transaction that changes the update log, so a rollback reverts the hash too. */
    track: <T>(callback: () => T): T => {
      if (!store || active) {
        return callback();
      }
      const initialSum = readSum(store);
      const accumulator = createStateHashAccumulator({ sum: initialSum, getColumns });
      active = accumulator;
      try {
        const result = callback();
        if (accumulator.sum !== initialSum) {
          store.write(formatStateHash(getSchemaVersion(), accumulator.sum));
        }
        return result;
      } finally {
        active = null;
      }
    },
  };
}
