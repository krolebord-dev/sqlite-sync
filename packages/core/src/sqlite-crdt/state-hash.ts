import { xxhash } from "../hash";
import type { CrdtUpdateLogPayload } from "./crdt-table-schema";

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
 * update log counts as written by the item's create (the HLC stored under `id`):
 * replaying an old create through an add-column migration stamps the default
 * that way, while replicas that applied it before the migration never stored it.
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
    /** `meta` is the item's update log after the write; `previousHlc` is the cell's HLC before it. */
    replaceCell(
      dataset: string,
      itemId: string,
      meta: CrdtUpdateLogPayload,
      column: string,
      previousHlc: string | undefined,
    ) {
      const columns = getColumns(dataset);
      if (columns ? !columns.includes(column) : column === "id") {
        return;
      }
      const previous = previousHlc ?? (columns ? (meta.id ?? "") : undefined);
      if (previous !== undefined) {
        current = BigInt.asUintN(64, current - cellHash(dataset, itemId, column, previous));
      }
      current = BigInt.asUintN(64, current + cellHash(dataset, itemId, column, meta[column]));
    },
  };
}
