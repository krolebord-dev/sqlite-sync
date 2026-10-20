import type { BindableValue, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;
type Callback = (() => void) | null | undefined;
type UpdateCallback = ((params: { table: string; operation: string; rowId: number }) => void) | null | undefined;

let sqlite3: Sqlite3Static | null = null;

export async function loadFakeOpSqlite() {
  sqlite3 ??= await sqlite3InitModule();
}

/**
 * op-sqlite's observable behavior on top of sqlite-wasm: synchronous raw execution,
 * blobs as ArrayBuffers, and hooks posted to the JS thread after the call returns.
 */
export function createFakeOpSqlite() {
  const files = new Map<string, Uint8Array<ArrayBufferLike>>();
  const deleted: string[] = [];

  const open = ({ name, location }: { name: string; location?: string }) => {
    if (!sqlite3) {
      throw new Error("Call loadFakeOpSqlite() first");
    }
    const { capi, oo1, wasm } = sqlite3;
    const db = new oo1.DB({ filename: ":memory:" });
    const path = location === ":memory:" ? null : `${location ?? "default"}/${name}`;
    const file = path ? files.get(path) : undefined;
    if (file) {
      const pointer = wasm.allocFromTypedArray(file);
      db.checkRc(
        capi.sqlite3_deserialize(
          db,
          "main",
          pointer,
          file.byteLength,
          file.byteLength,
          capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
        ),
      );
    }

    let onUpdate: UpdateCallback = null;
    let onCommit: Callback = null;
    let onRollback: Callback = null;
    capi.sqlite3_update_hook(
      db,
      (_ctx, _op, _db, table, rowId) => {
        const callback = onUpdate;
        setTimeout(() => callback?.({ table, operation: "UPDATE", rowId: Number(rowId) }));
      },
      0,
    );
    capi.sqlite3_commit_hook(
      db,
      () => {
        const callback = onCommit;
        setTimeout(() => callback?.());
        return 0;
      },
      0,
    );
    capi.sqlite3_rollback_hook(
      db,
      () => {
        const callback = onRollback;
        setTimeout(() => callback?.());
        return 0;
      },
      0,
    );

    let isOpen = true;
    const close = (persist: boolean) => {
      if (!isOpen) {
        throw new Error("[op-sqlite] database is closed");
      }
      isOpen = false;
      if (persist && path) {
        files.set(path, capi.sqlite3_js_db_export(db));
      }
      db.close();
    };

    return {
      executeRawSync: (sql: string, params: Scalar[] = []) => {
        const statement = db.prepare(sql);
        try {
          if (params.length > 0) {
            statement.bind(params.map(toBindable));
          }
          const rawRows: Scalar[][] = [];
          while (statement.step()) {
            rawRows.push(statement.get([]).map(toScalar));
          }
          const columnNames = statement.columnCount > 0 ? statement.getColumnNames([]) : [];
          return { rawRows, columnNames, rowsAffected: db.changes() };
        } finally {
          statement.finalize();
        }
      },
      updateHook: (callback: UpdateCallback) => {
        onUpdate = callback;
      },
      commitHook: (callback: Callback) => {
        onCommit = callback;
      },
      rollbackHook: (callback: Callback) => {
        onRollback = callback;
      },
      close: () => close(true),
      delete: () => {
        close(false);
        if (!path || !files.has(path)) {
          throw new Error(`[op-sqlite] db file not found: ${path}`);
        }
        deleted.push(path);
        files.delete(path);
      },
    };
  };

  return { open, files, deleted };
}

function toBindable(value: Scalar): BindableValue {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

function toScalar(value: unknown): Scalar {
  if (value instanceof Uint8Array) {
    return value.slice().buffer;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value as Scalar;
}
