import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { BoundMap } from "../bound-map";
import { type Logger, startPerformanceLogger } from "../logger";
import { type PreparedStatement, SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createTypedEventTarget, type TypedEvent } from "../utils";

let sqliteModule: Sqlite3Static | null = null;

type TableName<Database> = keyof Database extends string ? keyof Database : never;

type SQLiteReactiveDbOptions = {
  snapshot: Uint8Array<ArrayBufferLike>;
  logger: Logger;
};

type EventsMap = {
  "transaction-committed": undefined;
  "transaction-rolled-back": undefined;
  "any-table-changed": undefined;
} & Record<`table:${string}`, void>;

type LiveQuery<TResult> = {
  getRows: () => TResult[];
  refresh: () => void;
  subscribe: (onchange: () => void) => () => void;
};

export type SharedLiveQuery<TResult> = LiveQuery<TResult> & {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  getSubscriberCount: () => number;
};

type SharedLiveQueryEntry<TResult> = SharedLiveQuery<TResult> & {
  listeners: Set<() => void>;
  unsubscribeFromLiveQuery: (() => void) | null;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
};

export function createSQLiteReactiveDb<Database>(opts: SQLiteReactiveDbOptions) {
  return SQLiteReactiveDb.create<Database>(opts);
}

export class SQLiteReactiveDb<Database> {
  readonly db: SQLiteDbWrapper<Database>;
  private sqlite3: Sqlite3Static;

  private readonly logger: Logger;

  private tablesUsedStatement: PreparedStatement<[string], { name: string; isWrite: boolean }> | null = null;

  private eventTarget = createTypedEventTarget<EventsMap>();

  private constructor(sqlite3: Sqlite3Static, logger: Logger) {
    this.sqlite3 = sqlite3;
    this.logger = logger;

    this.db = new SQLiteDbWrapper({
      db: () => new sqlite3.oo1.DB({ filename: ":memory:" }),
      logger: this.logger,
      loggerPrefix: "memory",
      sqlite3,
    });
  }

  static async create<Database>(opts: SQLiteReactiveDbOptions) {
    const logger = opts.logger;
    const perf = startPerformanceLogger(logger);
    if (!sqliteModule) {
      sqliteModule = await sqlite3InitModule();
    }

    const db = new SQLiteReactiveDb<Database>(sqliteModule, logger);

    if (opts.snapshot) {
      db.useSnapshot(opts.snapshot);
    }
    db.registerDbHooks();

    perf.logEnd("createSQLiteMemoryDb", "success", "system");

    return db;
  }

  private liveQueryStatements = new BoundMap<string, PreparedStatement<any[], unknown>>({
    maxSize: 100,
    onRemove(_, value) {
      value.finalize();
    },
  });

  private sharedLiveQueries = new Map<string, SharedLiveQueryEntry<unknown>[]>();

  createLiveQuery<TResult>(query: { sql: string; parameters: readonly unknown[] }) {
    const fetchRows = (parameters: readonly unknown[]) => {
      let statement = this.liveQueryStatements.get(query.sql);
      if (!statement) {
        statement = this.db.prepare<any[], any>(query.sql);
        this.liveQueryStatements.set(query.sql, statement);
      }
      return statement.execute(parameters as any) as TResult[];
    };

    let rows: TResult[] | null = null;

    const getRows = () => {
      if (!rows) {
        rows = fetchRows(query.parameters);
      }
      return rows;
    };

    let subscriber: (() => void) | null = null;

    let lastParameters: readonly unknown[] = query.parameters;
    const refresh = (parameters?: readonly unknown[]) => {
      if (parameters) {
        lastParameters = parameters;
      }
      rows = fetchRows(lastParameters);
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

  getSharedLiveQuery<TResult>(query: { sql: string; parameters: readonly unknown[] }) {
    const existingEntry = this.sharedLiveQueries
      .get(query.sql)
      ?.find((entry) => parametersAreEqual(entry.parameters, query.parameters));
    if (existingEntry) {
      if (existingEntry.listeners.size === 0) {
        this.scheduleSharedLiveQueryCleanup(existingEntry);
      }
      return existingEntry as SharedLiveQuery<TResult>;
    }

    const liveQuery = this.createLiveQuery<TResult>(query);
    const entry: SharedLiveQueryEntry<TResult> = {
      sql: query.sql,
      parameters: query.parameters,
      listeners: new Set(),
      unsubscribeFromLiveQuery: null,
      cleanupTimeout: null,
      getRows: () => liveQuery.getRows(),
      refresh: () => {
        liveQuery.refresh();
      },
      getSubscriberCount: () => entry.listeners.size,
      subscribe: (onchange) => {
        this.cancelSharedLiveQueryCleanup(entry);
        entry.listeners.add(onchange);

        if (!entry.unsubscribeFromLiveQuery) {
          entry.unsubscribeFromLiveQuery = liveQuery.subscribe(() => {
            for (const listener of entry.listeners) {
              listener();
            }
          });
        }

        return () => {
          entry.listeners.delete(onchange);

          if (entry.listeners.size === 0) {
            entry.unsubscribeFromLiveQuery?.();
            entry.unsubscribeFromLiveQuery = null;
            this.scheduleSharedLiveQueryCleanup(entry);
          }
        };
      },
    };

    const matchingSqlEntries = this.sharedLiveQueries.get(query.sql) ?? [];
    matchingSqlEntries.push(entry as SharedLiveQueryEntry<unknown>);
    this.sharedLiveQueries.set(query.sql, matchingSqlEntries);

    // Evict the entry if no subscriber attaches by the next tick (e.g. a
    // discarded React render that never commits).
    this.scheduleSharedLiveQueryCleanup(entry as SharedLiveQueryEntry<unknown>);

    return entry;
  }

  private scheduleSharedLiveQueryCleanup(entry: SharedLiveQueryEntry<unknown>) {
    this.cancelSharedLiveQueryCleanup(entry);
    entry.cleanupTimeout = setTimeout(() => {
      entry.cleanupTimeout = null;
      this.releaseSharedLiveQuery(entry);
    }, 0);
  }

  private cancelSharedLiveQueryCleanup(entry: SharedLiveQueryEntry<unknown>) {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
  }

  private releaseSharedLiveQuery(entry: SharedLiveQueryEntry<unknown>) {
    if (entry.listeners.size > 0 || entry.unsubscribeFromLiveQuery) {
      return;
    }

    const matchingSqlEntries = this.sharedLiveQueries.get(entry.sql);
    if (!matchingSqlEntries) {
      return;
    }

    const nextEntries = matchingSqlEntries.filter((candidate) => candidate !== entry);
    if (nextEntries.length > 0) {
      this.sharedLiveQueries.set(entry.sql, nextEntries);
    } else {
      this.sharedLiveQueries.delete(entry.sql);
    }
  }

  subscribeToQueryChanges(params: { sql: string; onDataChange: () => void }) {
    const { sql, onDataChange } = params;

    const tables = this.getTablesUsed(sql);
    const readTables = new Set<string>();
    for (const table of tables) {
      if (!readTables.has(table.name)) {
        readTables.add(table.name);
      } else if (table.isWrite) {
        throw new Error("This query writes and reads from the same table. This may cause infinite loops.");
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
          this.eventTarget.removeEventListener(`table:${table}`, notifyDataChange);
        }
        this.eventTarget.removeEventListener("any-table-changed", notifyDataChange);
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
      this.tablesUsedStatement = this.db.prepare<[string], { name: string; isWrite: boolean }>(
        "select t.tbl_name as name, u.wr as isWrite from tables_used(?) as u inner join sqlite_master as t on t.name = u.name where u.schema = 'main'",
        { loggerLevel: "system" },
      );
    }

    const tables = this.tablesUsedStatement.execute([query]);

    if (tables.length === 0 && query.toLowerCase().includes("delete")) {
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
    }>(`EXPLAIN ${query.split(";")[0]}`, { loggerLevel: "system" }).rows;

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
        clearedTablesRootPages,
      ).join(",")})`,
      { loggerLevel: "system" },
    ).rows;

    return tableNames;
  }

  addEventListener<K extends keyof EventsMap>(type: K, listener: (event: TypedEvent<EventsMap[K]>) => void) {
    this.eventTarget.addEventListener(type, listener);
  }

  removeEventListener<K extends keyof EventsMap>(type: K, listener: (event: TypedEvent<EventsMap[K]>) => void) {
    this.eventTarget.removeEventListener(type, listener);
  }

  private notifyTableSubscribers(tables: (TableName<Database> | (string & {}))[] | Set<string> | null = null) {
    if (!tables) {
      this.eventTarget.dispatchEvent("any-table-changed", undefined);
      return;
    }

    for (const table of tables) {
      this.eventTarget.dispatchEvent(`table:${table}`, undefined);
    }
  }

  private registerDbHooks() {
    let updateQueue = new Set<string>();

    this.sqlite3.capi.sqlite3_update_hook(
      this.db.ensureDb,
      (_ctx, _opId, _db, table) => {
        updateQueue.add(table);
      },
      0,
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
      0,
    );

    this.sqlite3.capi.sqlite3_commit_hook(
      this.db.ensureDb,
      () => {
        if (updateQueue.size === 0) {
          return 0;
        }

        const tables = updateQueue;
        updateQueue = new Set<string>();
        this.eventTarget.dispatchEvent("transaction-committed", undefined);

        queueMicrotask(() => {
          this.notifyTableSubscribers(tables);
        });
        return 0;
      },
      0,
    );
  }

  createSnapshot() {
    const perf = startPerformanceLogger(this.logger);
    const snapshot = this.sqlite3.capi.sqlite3_js_db_export(this.db.ensureDb);
    perf.logEnd("createSnapshot", `snapshot size: ${snapshot.byteLength}`, "info");

    return snapshot;
  }

  useSnapshot(snapshot: Uint8Array<ArrayBufferLike>) {
    this.db.useSnapshot(snapshot);
    this.notifyTableSubscribers();
  }

  dispose() {
    for (const entries of this.sharedLiveQueries.values()) {
      for (const entry of entries) {
        this.cancelSharedLiveQueryCleanup(entry);
        entry.unsubscribeFromLiveQuery?.();
        entry.unsubscribeFromLiveQuery = null;
        entry.listeners.clear();
      }
    }
    this.sharedLiveQueries.clear();
    this.liveQueryStatements.clear();
    if (this.tablesUsedStatement) {
      this.tablesUsedStatement.finalize();
      this.tablesUsedStatement = null;
    }
    this.db.close();
  }
}

function createDebouncedCallback<TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay: number) {
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

export function parametersAreEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      return false;
    }
  }
  return true;
}
