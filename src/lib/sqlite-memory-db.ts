import sqlite3InitModule, {
  type BindableValue,
  type Database as SQLiteDatabase,
  type SqlValue,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type { Kysely } from "kysely";
import { createSQLiteMemoryKysely } from "./sqlite-memory-kysely-driver";

let sqliteModule: Sqlite3Static | null = null;

type ExecuteParams = {
  sql: string;
  params: readonly unknown[];
};

type ExecuteResult<T> = {
  rows: T[];
};

type PreparedStatement<TParams extends SqlValue[], TResult> = {
  execute: (params: TParams) => TResult[];
  finalize: () => void;
  isFinalized: boolean;
};

type Logger = (type: "info" | "warning" | "error", message: string) => void;

type SQLiteMemoryDbOptions = {
  logger?: Logger;
};

type ChangeType = "insert" | "update" | "delete";

type TableName<Database> = keyof Database extends string
  ? keyof Database
  : never;

class PerformanceLogger {
  private readonly logger: Logger;
  private startTime: number = performance.now();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  logStart() {
    this.startTime = performance.now();
  }

  logEnd(
    type: string,
    message: string,
    level: "info" | "warning" | "error" = "info"
  ) {
    const elapsed = performance.now() - this.startTime;
    this.startTime = performance.now();

    this.logger(level, `${type} - ${elapsed.toFixed(2)}ms - ${message}`);
  }
}

export class SQLiteMemoryDb<Database> {
  kysely: Kysely<Database>;

  private db: SQLiteDatabase | null = null;
  private sqlite3: Sqlite3Static;

  private readonly performanceLogger: PerformanceLogger;

  private tableSubscribers: Map<string, Set<(type: ChangeType) => void>> =
    new Map();

  private preparedStatements: PreparedStatement<SqlValue[], unknown>[] = [];
  private tablesUsedStatement: PreparedStatement<
    [string],
    { name: string; isWrite: boolean }
  > | null = null;

  private dataPointers = [] as number[];

  private constructor(sqlite3: Sqlite3Static, opts?: SQLiteMemoryDbOptions) {
    this.sqlite3 = sqlite3;
    this.db = new sqlite3.oo1.DB({ filename: ":memory:" });
    this.performanceLogger = new PerformanceLogger(opts?.logger ?? (() => {}));

    this.kysely = createSQLiteMemoryKysely<Database>(this);
  }

  static async create<Database>(opts?: SQLiteMemoryDbOptions) {
    if (!sqliteModule) {
      sqliteModule = await sqlite3InitModule();
    }

    const db = new SQLiteMemoryDb<Database>(sqliteModule, opts);

    db.registerOnUpdateHook();

    return db;
  }

  get ensureDb() {
    if (!this.db) {
      throw new Error("Database is already closed");
    }
    return this.db;
  }

  execute<T = unknown>(params: ExecuteParams | string): ExecuteResult<T> {
    const sql = typeof params === "string" ? params : params.sql;
    const bind = typeof params === "string" ? undefined : params.params;

    this.performanceLogger.logStart();
    const rows = this.ensureDb.exec({
      sql,
      bind: bind as BindableValue[],
      returnValue: "resultRows",
      rowMode: "object",
    });
    this.performanceLogger.logEnd("query", sql, "info");

    return { rows: rows as T[] };
  }

  executeTransaction<T>(callback: (db: SQLiteDatabase) => T): T {
    return this.ensureDb.transaction(callback);
  }

  // recordChanges() {
  //   const wasm = this.sqlite3.wasm;
  //   const capi = this.sqlite3.capi;

  //   const ptrStart = wasm.pstack.pointer;
  //   try {
  //     const ppOut = wasm.pstack.allocPtr();
  //     capi.sqlite3session_create(this.ensureDb, "main", ppOut);

  //     const pSession = wasm.peekPtr(ppOut);
  //     capi.sqlite3session_attach(pSession, null);

  //     for (let i = 0; i < 16000; i++) {
  //       this.execute({
  //         sql: 'insert into "users" ("name", "email") values (?, ?)',
  //         params: ["test" + i, "test" + i + "@test.com"],
  //       });
  //     }

  //     const pnChanges = wasm.pstack.alloc("i32");

  //     const result = capi.sqlite3session_changeset(pSession, pnChanges, ppOut);

  //     const size = wasm.peek32(pnChanges);
  //     const changesetPtr = wasm.peekPtr(ppOut);

  //     if (!changesetPtr || (!wasm.isPtr(changesetPtr) && changesetPtr < 1)) {
  //       throw new Error("Failed to get changeset");
  //     }

  //     capi.sqlite3changeset_invert(size, changesetPtr, pnChanges, ppOut);
  //     capi.sqlite3changeset_apply(
  //       this.ensureDb,
  //       wasm.peek32(pnChanges),
  //       wasm.peekPtr(ppOut),
  //       (...args) => {
  //         console.log("apply", ...args);
  //         return 1;
  //       },
  //       (...args) => {
  //         console.log("apply", ...args);
  //         return capi.SQLITE_CHANGESET_OMIT;
  //       },
  //       0
  //     );

  //     capi.sqlite3_free(changesetPtr);

  //     console.log("changeset", result, pnChanges, size);
  //   } finally {
  //     wasm.pstack.restore(ptrStart);
  //   }
  // }

  prepare<TParams extends SqlValue[], TResult>(sql: string) {
    const stmt = this.ensureDb.prepare(sql);
    let isFinalized = false;

    const execute = (params: TParams) => {
      if (isFinalized) {
        throw new Error("Statement is finalized");
      }

      stmt.bind(params);
      const results = [] as TResult[];
      while (stmt.step()) {
        results.push(stmt.get({}) as TResult);
      }
      stmt.reset(true);
      return results;
    };

    const finalize = () => {
      isFinalized = true;
      stmt.finalize();
    };

    const preparedStatement: PreparedStatement<TParams, TResult> = {
      execute,
      finalize,
      get isFinalized() {
        return isFinalized;
      },
    };

    this.preparedStatements.push(
      preparedStatement as PreparedStatement<SqlValue[], unknown>
    );

    return preparedStatement;
  }

  sql(templateOrString: TemplateStringsArray | string, ...params: unknown[]) {
    if (typeof templateOrString === "string") {
      return this.execute({
        sql: templateOrString,
        params: params as BindableValue[],
      });
    }
    return this.execute({
      sql: templateOrString.join("?"),
      params: params as BindableValue[],
    });
  }

  createLiveQuery<TResult>(query: {
    sql: string;
    parameters: readonly unknown[];
  }) {
    const fetchRows = () =>
      this.execute<TResult>({
        sql: query.sql,
        params: query.parameters ?? [],
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

  getTablesUsed(query: string) {
    if (!this.tablesUsedStatement) {
      this.tablesUsedStatement = this.prepare<
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
    const operations = this.execute<{
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

    const tableNames = this.execute<{ name: string; isWrite: boolean }>(
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
    return this.ensureDb.createFunction({
      name,
      xFunc: (_, ...args) => {
        const result = callback(...(args as TArgs)) as SqlValue;
        return result;
      },
      arity: -1,
    });
  }

  private onUpdateHook(table: string, type: ChangeType) {
    this.tableSubscribers.get(table)?.forEach((subscriber) => {
      try {
        subscriber(type);
      } catch (error) {
        console.error(`Error calling table [${table}] subscriber`, error);
      }
    });
  }

  notifyTableSubscribers(tables: (TableName<Database> | (string & {}))[] = []) {
    this.tableSubscribers.forEach((subscribers, table) => {
      if (tables.length > 0 && !tables.includes(table)) {
        return;
      }

      subscribers.forEach((subscriber) => subscriber("update"));
    });
  }

  private registerOnUpdateHook() {
    const opMap: Record<number, ChangeType> = {
      [this.sqlite3.capi.SQLITE_INSERT]: "insert",
      [this.sqlite3.capi.SQLITE_UPDATE]: "update",
      [this.sqlite3.capi.SQLITE_DELETE]: "delete",
    };

    this.sqlite3.capi.sqlite3_update_hook(
      this.ensureDb,
      (_ctx, opId, _db, table) => {
        this.onUpdateHook(table, opMap[opId]);
      },
      0
    );
  }

  createSnapshot() {
    this.performanceLogger.logStart();
    const snapshot = this.sqlite3.capi.sqlite3_js_db_export(this.ensureDb);
    this.performanceLogger.logEnd(
      "createSnapshot",
      `snapshot size: ${snapshot.byteLength}`,
      "info"
    );

    return snapshot;
  }

  useSnapshot(snapshot: Uint8Array<ArrayBuffer>) {
    this.performanceLogger.logStart();
    const dataPointer = this.sqlite3.wasm.allocFromTypedArray(snapshot);
    this.dataPointers.push(dataPointer);

    const resultCode = this.sqlite3.capi.sqlite3_deserialize(
      this.ensureDb,
      "main",
      dataPointer,
      snapshot.byteLength,
      snapshot.byteLength,
      this.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    this.ensureDb.checkRc(resultCode);
    this.performanceLogger.logEnd("useSnapshot", "success", "info");

    this.notifyTableSubscribers();
  }

  close() {
    this.preparedStatements.forEach((stmt) => stmt.finalize());
    this.tablesUsedStatement = null;
    this.preparedStatements = [];

    this.db?.close();
    this.db = null;
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
