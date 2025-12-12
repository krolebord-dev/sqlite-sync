import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { startPerformanceLogger, type Logger } from "../logger";
import { SQLiteDbWrapper, type PreparedStatement } from "../sqlite-db-wrapper";
import { createTypedEventTarget, TypedEvent } from "../utils";

let sqliteModule: Sqlite3Static | null = null;

type TableName<Database> = keyof Database extends string
  ? keyof Database
  : never;

type SQLiteReactiveDbOptions = {
  snapshot?: Uint8Array<ArrayBufferLike>;
  logger?: Logger;
};

type EventsMap = {
  "transaction-committed": void;
  "transaction-rolled-back": void;
  "any-table-changed": void;
} & Record<`table:${string}`, void>;

export function createSQLiteReactiveDb<Database>(
  opts: SQLiteReactiveDbOptions
) {
  return SQLiteReactiveDb.create<Database>(opts);
}

const defaultLogger: Logger = (type, message, level = "info") => {
  const logMessage = `[${type}] ${message}`;
  switch (level) {
    case "info":
      console.log(logMessage);
      break;
    case "warning":
      console.warn(logMessage);
      break;
    case "error":
      console.error(logMessage);
      break;
    case "trace":
      console.trace(logMessage);
      break;
  }
};

export class SQLiteReactiveDb<Database> {
  readonly db: SQLiteDbWrapper<Database>;
  private sqlite3: Sqlite3Static;

  private readonly logger: Logger;

  private tablesUsedStatement: PreparedStatement<
    [string],
    { name: string; isWrite: boolean }
  > | null = null;

  private eventTarget = createTypedEventTarget<EventsMap>();

  private constructor(sqlite3: Sqlite3Static, logger: Logger) {
    this.sqlite3 = sqlite3;
    this.logger = logger;

    this.db = new SQLiteDbWrapper({
      db: new sqlite3.oo1.DB({ filename: ":memory:" }),
      logger: this.logger,
      loggerPrefix: "memory",
      sqlite3,
    });
  }

  static async create<Database>(opts: SQLiteReactiveDbOptions) {
    const logger = opts.logger ?? defaultLogger;
    const perf = startPerformanceLogger(logger);
    if (!sqliteModule) {
      sqliteModule = await sqlite3InitModule();
    }

    const db = new SQLiteReactiveDb<Database>(sqliteModule, logger);

    if (opts.snapshot) {
      db.useSnapshot(opts.snapshot);
    }
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
      this.eventTarget.addEventListener(`table:${table}`, notifyDataChange);
    }
    this.eventTarget.addEventListener("any-table-changed", notifyDataChange);

    return {
      unsubscribe: () => {
        for (const table of readTables) {
          this.eventTarget.removeEventListener(
            `table:${table}`,
            notifyDataChange
          );
          this.eventTarget.removeEventListener(
            "any-table-changed",
            notifyDataChange
          );
        }
      },
    };
  }

  subscribeToTableChanges(table: string, onChanges: () => void) {
    this.eventTarget.addEventListener(`table:${table}`, onChanges);
    this.eventTarget.addEventListener("any-table-changed", onChanges);
    return {
      unsubscribe: () => {
        this.eventTarget.removeEventListener(`table:${table}`, onChanges);
        this.eventTarget.removeEventListener("any-table-changed", onChanges);
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

  addEventListener<K extends keyof EventsMap>(
    type: K,
    listener: (event: TypedEvent<EventsMap[K]>) => void
  ) {
    this.eventTarget.addEventListener(type, listener);
  }

  removeEventListener<K extends keyof EventsMap>(
    type: K,
    listener: (event: TypedEvent<EventsMap[K]>) => void
  ) {
    this.eventTarget.removeEventListener(type, listener);
  }

  notifyTableSubscribers(tables: (TableName<Database> | (string & {}))[] = []) {
    if (tables.length === 0) {
      this.eventTarget.dispatchEvent("any-table-changed", undefined);
      return;
    }

    for (const table of tables) {
      this.eventTarget.dispatchEvent(`table:${table}`, undefined);
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
        this.eventTarget.dispatchEvent("transaction-rolled-back", undefined);

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
        this.eventTarget.dispatchEvent("transaction-committed", undefined);

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
    this.db.useSnapshot(snapshot);
    this.notifyTableSubscribers();
  }
}

function createDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number
) {
  let timeout: unknown | null = null;
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
      clearTimeout(timeout as any);
    }

    timeout = setTimeout(effect, delay);
  };
}
