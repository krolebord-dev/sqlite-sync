import type { DB, Scalar } from "@op-engineering/op-sqlite";
import type { SqliteDriver, SqliteDriverValue } from "@sqlite-sync/core";

const BYTECODE_VTAB_HELP =
  'sqlite-sync needs SQLite\'s bytecode virtual tables. Add `"op-sqlite": { "sqliteFlags": "-DSQLITE_ENABLE_BYTECODE_VTAB=1" }` to your app\'s package.json and rebuild the native app.';

/**
 * Adapts an op-sqlite connection. Statements run through op-sqlite's synchronous API on
 * the JS thread; its hooks are delivered asynchronously, in order, after each call returns.
 */
export function createOpSqliteDriver(db: DB): SqliteDriver {
  try {
    db.executeRawSync("select 1 from tables_used('select 1')");
  } catch (error) {
    throw new Error(`${BYTECODE_VTAB_HELP} (${error instanceof Error ? error.message : String(error)})`);
  }

  const run = (sql: string, parameters: readonly unknown[]) => {
    const result = db.executeRawSync(sql, parameters.map(toScalar));
    return {
      columns: result.columnNames ?? [],
      rows: toDriverRows(result.rawRows),
    };
  };

  return {
    prepare: (sql) => ({
      run: (parameters) => run(sql, parameters),
      finalize: () => {},
    }),
    totalChanges: () => Number(db.executeRawSync("select total_changes()").rawRows[0]?.[0] ?? 0),
    synchronousHooks: false,
    setHooks: (hooks) => {
      if (!hooks) {
        db.updateHook(null);
        db.commitHook(null);
        db.rollbackHook(null);
        return;
      }
      db.updateHook(({ table }) => hooks.onUpdate(table));
      db.commitHook(() => hooks.onCommit());
      db.rollbackHook(() => hooks.onRollback());
    },
    close: () => {
      db.close();
    },
  };
}

function toScalar(value: unknown): Scalar {
  switch (typeof value) {
    case "undefined":
      return null;
    case "bigint":
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(`Cannot bind ${value}: op-sqlite binds numbers as doubles`);
      }
      return Number(value);
    default:
      return value as Scalar;
  }
}

/**
 * Converts op-sqlite values in place: op-sqlite builds fresh row arrays on every call, and nearly
 * every value (string, number, null) needs no conversion, so copying each row would only allocate.
 */
function toDriverRows(rawRows: Scalar[][]): SqliteDriverValue[][] {
  for (let r = 0; r < rawRows.length; r++) {
    const row = rawRows[r] as unknown[];
    for (let c = 0; c < row.length; c++) {
      const value = row[c];
      if (typeof value === "object") {
        if (value instanceof ArrayBuffer) {
          row[c] = new Uint8Array(value);
        }
      } else if (typeof value === "boolean") {
        row[c] = value ? 1 : 0;
      }
    }
  }
  return rawRows as SqliteDriverValue[][];
}
