// Structural sharing for live queries: compares fresh raw driver rows with the previous ones (by
// position, then by `id`) and reuses the previous object when all values are equal, so matching
// only affects the hit rate, never correctness. Returns the previous array if nothing changed.

import type { SqliteDriverRows, SqliteDriverValue } from "../sqlite-driver";

export type ReconciledRows<T> = { raw: SqliteDriverRows; rows: T[] };

export function reconcileRows<T>(previous: ReconciledRows<T> | null, next: SqliteDriverRows): T[] {
  if (!previous || !sameColumns(previous.raw.columns, next.columns)) {
    return next.rows.map((values) => buildRow<T>(next.columns, values));
  }

  const columns = next.columns;
  const columnCount = columns.length;
  const prevRaw = previous.raw.rows;
  const prevRows = previous.rows;
  const nextRaw = next.rows;
  const idIndex = columns.indexOf("id");

  const result = new Array<T>(nextRaw.length);
  let allInPlace = prevRaw.length === nextRaw.length;
  let byId: Map<SqliteDriverValue, number> | null = null;

  for (let r = 0; r < nextRaw.length; r++) {
    const values = nextRaw[r];
    if (r < prevRaw.length && valuesEqual(prevRaw[r], values, columnCount)) {
      result[r] = prevRows[r];
      continue;
    }
    allInPlace = false;

    if (idIndex !== -1) {
      if (!byId) {
        byId = new Map();
        // Backwards, so the first row with a duplicate id wins.
        for (let p = prevRaw.length - 1; p >= 0; p--) {
          byId.set(prevRaw[p][idIndex], p);
        }
      }
      const candidate = byId.get(values[idIndex]);
      if (candidate !== undefined && valuesEqual(prevRaw[candidate], values, columnCount)) {
        result[r] = prevRows[candidate];
        continue;
      }
    }

    result[r] = buildRow<T>(columns, values);
  }

  return allInPlace ? prevRows : result;
}

function buildRow<T>(columns: string[], values: SqliteDriverValue[]): T {
  const row: Record<string, unknown> = {};
  for (let c = 0; c < columns.length; c++) {
    row[columns[c]] = values[c];
  }
  return row as T;
}

function sameColumns(a: string[], b: string[]) {
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

function valuesEqual(a: SqliteDriverValue[], b: SqliteDriverValue[], count: number) {
  for (let c = 0; c < count; c++) {
    const x = a[c];
    const y = b[c];
    if (Object.is(x, y)) continue;
    if (x instanceof Uint8Array && y instanceof Uint8Array && bytesEqual(x, y)) continue;
    return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
