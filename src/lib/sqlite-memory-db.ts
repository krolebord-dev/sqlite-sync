import sqlite3InitModule, {
  type FunctionOptions,
  type SqlValue,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import { startPerformanceLogger, type Logger } from "./logger";
import { SQLiteDbWrapper, type PreparedStatement } from "./sqlite-db-wrapper";

let sqliteModule: Sqlite3Static | null = null;

type SQLiteMemoryDbOptions = {
  logger?: Logger;
};

type TableName<Database> = keyof Database extends string
  ? keyof Database
  : never;

type ScalarFunctionOptions<
  TArgs extends readonly SqlValue[],
  TResult extends SqlValue
> = {
  name: string;
  callback: (...args: TArgs) => TResult;
} & Pick<FunctionOptions, "deterministic" | "directOnly" | "innocuous">;

export class SQLiteMemoryDb<Database> {
  readonly db: SQLiteDbWrapper;
  private sqlite3: Sqlite3Static;

  private readonly logger: Logger;

  private readonly tableSubscribers: Map<string, Set<() => void>> = new Map();

  private readonly dataPointers = [] as number[];

  private tablesUsedStatement: PreparedStatement<
    [string],
    { name: string; isWrite: boolean }
  > | null = null;

  private constructor(sqlite3: Sqlite3Static, opts?: SQLiteMemoryDbOptions) {
    this.sqlite3 = sqlite3;
    this.logger = opts?.logger ?? (() => {});

    this.db = new SQLiteDbWrapper({
      db: new sqlite3.oo1.DB({ filename: ":memory:" }),
      logger: this.logger,
      loggerPrefix: "memory",
    });
  }

  static async create<Database>(opts?: SQLiteMemoryDbOptions) {
    const perf = startPerformanceLogger(opts?.logger ?? (() => {}));
    if (!sqliteModule) {
      sqliteModule = await sqlite3InitModule();
    }

    const db = new SQLiteMemoryDb<Database>(sqliteModule, opts);

    db.registerDbHooks();

    perf.logEnd("createSQLiteMemoryDb", "success", "info");

    return db;
  }

  createLiveQuery<TResult>(query: {
    sql: string;
    parameters: readonly unknown[];
  }) {
    const fetchRows = () =>
      this.db.execute<TResult>({
        sql: query.sql,
        parameters: query.parameters ?? [],
      }).rows;

    let rows: TResult[] | null = null;

    const getRows = () => {
      if (!rows) {
        rows = fetchRows();
      }
      return rows;
    };

    let subscriber: (() => void) | null = null;

    const refresh = () => {
      rows = fetchRows();
      subscriber?.();
    };

    const subscribe = (onchange: () => void) => {
      if (subscriber) {
        throw new Error("Subscriber already exists");
      }

      subscriber = onchange;
      const subscription = this.subscribeToQueryChanges({
        sql: query.sql,
        onDataChange: refresh,
      });

      return () => {
        subscription.unsubscribe();
        subscriber = null;
      };
    };

    return { getRows, refresh, subscribe };
  }

  subscribeToQueryChanges(params: { sql: string; onDataChange: () => void }) {
    const { sql, onDataChange } = params;

    const tables = this.getTablesUsed(sql);
    const readTables = new Set<string>();
    for (const table of tables) {
      if (!readTables.has(table.name)) {
        readTables.add(table.name);
      } else if (table.isWrite) {
        throw new Error(
          "This query writes and reads from the same table. This may cause infinite loops."
        );
      }
    }

    const notifyDataChange = createDebouncedCallback(() => {
      onDataChange();
    }, 30);

    for (const table of readTables) {
      let subscribers = this.tableSubscribers.get(table);
      if (!subscribers) {
        subscribers = new Set();
        this.tableSubscribers.set(table, subscribers);
      }
      subscribers.add(notifyDataChange);
    }

    return {
      unsubscribe: () => {
        for (const table of readTables) {
          this.tableSubscribers.get(table)?.delete(notifyDataChange);
        }
      },
    };
  }

  subscribeToTableChanges(table: string, onChanges: () => void) {
    let subscribers = this.tableSubscribers.get(table);
    if (!subscribers) {
      subscribers = new Set();
      this.tableSubscribers.set(table, subscribers);
    }
    subscribers.add(onChanges);

    return {
      unsubscribe: () => {
        subscribers.delete(onChanges);
      },
    };
  }

  getTablesUsed(query: string) {
    if (!this.tablesUsedStatement) {
      this.tablesUsedStatement = this.db.prepare<
        [string],
        { name: string; isWrite: boolean }
      >(
        "select t.tbl_name as name, u.wr as isWrite from tables_used(?) as u inner join sqlite_master as t on t.name = u.name where u.schema = 'main'"
      );
    }

    const tables = this.tablesUsedStatement.execute([query]);

    if (tables.length == 0 && query.toLowerCase().includes("delete")) {
      // tables_used function does not work with delete queries that clear entire tables
      tables.push(...this.getClearedTables(query));
    }

    return tables;
  }

  private getClearedTables(query: string) {
    const operations = this.db.execute<{
      opcode: string;
      p1: number;
      p2: number;
    }>(`EXPLAIN ${query.split(";")[0]}`).rows;

    const clearedTablesRootPages = new Set<number>();
    for (const operation of operations) {
      if (operation.opcode === "Clear" && operation.p2 === 0) {
        clearedTablesRootPages.add(operation.p1);
      }
    }

    if (clearedTablesRootPages.size === 0) {
      return [];
    }

    const tableNames = this.db.execute<{ name: string; isWrite: boolean }>(
      `select t.tbl_name as name, true as isWrite from sqlite_master as t where t.rootpage in (${Array.from(
        clearedTablesRootPages
      ).join(",")})`
    ).rows;

    return tableNames;
  }

  createCallbackFunction<
    TArgs extends SqlValue[],
    TResult extends SqlValue | void = void
  >(name: string, callback: (...args: TArgs) => TResult) {
    return this.db.ensureDb.createFunction({
      name,
      arity: callback.length,
      xFunc: (_, ...args) => {
        const result = callback(...(args as TArgs)) as SqlValue;
        return result;
      },
    });
  }

  createScalarFunction<TArgs extends SqlValue[], TResult extends SqlValue>({
    name,
    callback,
    deterministic,
    directOnly,
    innocuous,
  }: ScalarFunctionOptions<TArgs, TResult>) {
    return this.db.ensureDb.createFunction({
      name,
      xFunc: (_, ...args) => {
        const result = callback(...(args as TArgs)) as SqlValue;
        return result;
      },
      arity: callback.length,
      deterministic,
      directOnly,
      innocuous,
    });
  }

  notifyTableSubscribers(tables: (TableName<Database> | (string & {}))[] = []) {
    if (tables.length === 0) {
      this.tableSubscribers.forEach((subscribers) => {
        subscribers.forEach((subscriber) => subscriber());
      });
      return;
    }

    for (const table of tables) {
      this.tableSubscribers.get(table)?.forEach((subscriber) => subscriber());
    }
  }

  private registerDbHooks() {
    const updateQueue = new Set<string>();

    this.sqlite3.capi.sqlite3_update_hook(
      this.db.ensureDb,
      (_ctx, _opId, _db, table) => {
        updateQueue.add(table);
      },
      0
    );

    this.sqlite3.capi.sqlite3_rollback_hook(
      this.db.ensureDb,
      () => {
        if (updateQueue.size === 0) {
          return 0;
        }

        updateQueue.clear();
        return 0;
      },
      0
    );

    this.sqlite3.capi.sqlite3_commit_hook(
      this.db.ensureDb,
      () => {
        if (updateQueue.size === 0) {
          return 0;
        }

        const tables = Array.from(updateQueue);
        updateQueue.clear();

        queueMicrotask(() => {
          this.notifyTableSubscribers(tables);
        });
        return 0;
      },
      0
    );
  }

  createSnapshot() {
    const perf = startPerformanceLogger(this.logger);
    const snapshot = this.sqlite3.capi.sqlite3_js_db_export(this.db.ensureDb);
    perf.logEnd(
      "createSnapshot",
      `snapshot size: ${snapshot.byteLength}`,
      "info"
    );

    return snapshot;
  }

  useSnapshot(snapshot: Uint8Array<ArrayBufferLike>) {
    const perf = startPerformanceLogger(this.logger);
    const dataPointer = this.sqlite3.wasm.allocFromTypedArray(snapshot);
    this.dataPointers.push(dataPointer);

    const resultCode = this.sqlite3.capi.sqlite3_deserialize(
      this.db.ensureDb,
      "main",
      dataPointer,
      snapshot.byteLength,
      snapshot.byteLength,
      this.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    this.db.ensureDb.checkRc(resultCode);
    perf.logEnd("useSnapshot", "success", "info");

    this.notifyTableSubscribers();
  }
}

function createDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number
) {
  let timeout: number | null = null;
  let shouldCallWithoutDelay = true;

  return (...args: TArgs) => {
    if (shouldCallWithoutDelay) {
      callback(...args);
      shouldCallWithoutDelay = false;
      return;
    }

    const effect = () => {
      timeout = null;
      shouldCallWithoutDelay = true;
      return callback(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(effect, delay);
  };
}
