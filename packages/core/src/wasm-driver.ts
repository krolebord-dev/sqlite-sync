import sqlite3InitModule, {
  type BindableValue,
  type Database,
  type Sqlite3Static,
  type SqlValue,
} from "@sqlite.org/sqlite-wasm";
import type { SqliteDriver, SqliteDriverStatement, SqliteDriverValue } from "./sqlite-driver";

let sqliteModulePromise: Promise<Sqlite3Static> | null = null;

export function loadSqliteWasm() {
  sqliteModulePromise ??= sqlite3InitModule();
  return sqliteModulePromise;
}

export async function createWasmMemoryDriver() {
  const sqlite3 = await loadSqliteWasm();
  return createWasmSqliteDriver(sqlite3, new sqlite3.oo1.DB({ filename: ":memory:" }));
}

export function createWasmSqliteDriver(sqlite3: Sqlite3Static, db: Database): SqliteDriver {
  const { capi } = sqlite3;

  const prepare = (sql: string): SqliteDriverStatement => {
    const statement = db.prepare(sql);
    const pointer = statement.pointer;
    if (!pointer) {
      throw new Error("Prepared statement is already finalized");
    }

    return {
      readonly: capi.sqlite3_stmt_readonly(pointer) !== 0,
      run: (parameters) => {
        try {
          if (parameters.length > 0) {
            statement.bind(parameters as BindableValue[]);
          }

          const rows: SqliteDriverValue[][] = [];
          let columns: string[] | undefined;
          while (statement.step()) {
            columns ??= statement.getColumnNames([]);
            rows.push(statement.get([]) as SqliteDriverValue[]);
          }
          return { columns: columns ?? [], rows };
        } finally {
          statement.reset(true);
        }
      },
      finalize: () => {
        statement.finalize();
      },
    };
  };

  return {
    prepare,
    synchronousHooks: true,
    totalChanges: () => capi.sqlite3_total_changes(db),
    setHooks: (hooks) => {
      if (!hooks) {
        capi.sqlite3_update_hook(db, 0 as never, 0);
        capi.sqlite3_rollback_hook(db, 0, 0);
        capi.sqlite3_commit_hook(db, 0, 0);
        return;
      }

      capi.sqlite3_update_hook(db, (_ctx, _opId, _db, table) => hooks.onUpdate(table), 0);
      capi.sqlite3_rollback_hook(
        db,
        () => {
          hooks.onRollback();
          return 0;
        },
        0,
      );
      capi.sqlite3_commit_hook(
        db,
        () => {
          hooks.onCommit();
          return 0;
        },
        0,
      );
    },
    serialize: () => capi.sqlite3_js_db_export(db),
    deserialize: (snapshot) => {
      const dataPointer = sqlite3.wasm.allocFromTypedArray(snapshot);
      const resultCode = capi.sqlite3_deserialize(
        db,
        "main",
        dataPointer,
        snapshot.byteLength,
        snapshot.byteLength,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      db.checkRc(resultCode);
    },
    createScalarFunction: ({ name, callback, arity, deterministic, directOnly, innocuous }) => {
      db.createFunction({
        name,
        xFunc: (_, ...args) => callback(...(args as SqliteDriverValue[])) as SqlValue,
        arity,
        deterministic,
        directOnly,
        innocuous,
      });
    },
    close: () => {
      db.close();
    },
  };
}
