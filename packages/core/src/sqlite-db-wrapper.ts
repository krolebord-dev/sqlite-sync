import type { Compilable, CompiledQuery, Kysely } from "kysely";
import { BoundMap } from "./bound-map";
import { dummyKysely } from "./dummy-kysely";
import { type DatabaseIntrospection, introspectDb } from "./introspection";
import { type Logger, startPerformanceLogger } from "./logger";
import type { SqliteDriver, SqliteDriverStatement, SqliteDriverValue } from "./sqlite-driver";

export type ExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

export type ExecuteResult<T> = {
  rows: T[];
};

export type PreparedStatement<TParams extends unknown[], TResult> = {
  execute: (parameters: TParams) => TResult[];
  finalize: () => void;
  isFinalized: boolean;
};

type ScalarFunctionOptions<
  TArgs extends readonly SqliteDriverValue[],
  TResult extends SqliteDriverValue | undefined,
> = {
  name: string;
  callback: (...args: TArgs) => TResult;
  deterministic?: boolean;
  directOnly?: boolean;
  innocuous?: boolean;
};

type SqliteWrapperOptions = {
  logger?: Logger;
  loggerPrefix?: string;
  driver: SqliteDriver;
};

export type SQLiteTransactionWrapper<TDatabase = unknown> = Pick<
  SQLiteDbWrapper<TDatabase>,
  "sql" | "execute" | "executePrepared" | "executePreparedRaw" | "executeKysely"
>;

export type InternalSQLiteTransactionWrapper<TDatabase = unknown> = Pick<
  SQLiteDbWrapper<TDatabase>,
  "executePrepared" | "executePreparedRaw"
>;

export type InternalSQLiteWrapper<TDatabase = unknown> = InternalSQLiteTransactionWrapper<TDatabase> & {
  executeTransaction: (callback: (db: InternalSQLiteTransactionWrapper<TDatabase>) => void) => void;
};

type QueryMetaOpts = {
  loggerLevel?: "info" | "system";
};

/** Runs after user SQL succeeds, before its transaction or savepoint is committed. */
type AfterMutatingStatement<TDatabase> = (db: InternalSQLiteTransactionWrapper<TDatabase>) => void;

type ExecuteOptions = QueryMetaOpts & {
  /** For internal mutations whose effects must not be processed by afterMutatingStatement. */
  skipAfterMutatingStatement?: boolean;
};

// sqlite3_stmt_readonly reports transaction control statements as read-only.
const TRANSACTION_CONTROL_PATTERN =
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:begin|commit|end|rollback|savepoint|release)\b/i;

export class SQLiteDbWrapper<TDatabase = unknown> {
  private driver: SqliteDriver | null;
  private logger?: Logger;
  private loggerPrefix?: string;

  private loadedDbSchema: DatabaseIntrospection | null = null;

  private preparedStatements: PreparedStatement<SqliteDriverValue[], unknown>[] = [];
  private preparedStatementsMap = new Map<string, TypedStatement<Record<string, unknown>, unknown>>();
  private preparedRawStatementsMap = new Map<string, PreparedStatement<SqliteDriverValue[], unknown>>();
  private readonlyStatementCache = new BoundMap<string, boolean>({ maxSize: 500, onRemove: undefined });
  private afterMutatingStatement: AfterMutatingStatement<TDatabase> | null = null;

  constructor(opts: SqliteWrapperOptions) {
    this.driver = opts.driver;
    this.logger = opts.logger;
    this.loggerPrefix = opts.loggerPrefix;
  }

  get ensureDriver() {
    if (!this.driver) {
      throw new Error("Database is already closed");
    }
    return this.driver;
  }

  get dbSchema() {
    if (!this.loadedDbSchema) {
      this.loadedDbSchema = introspectDb(this);
    }
    return this.loadedDbSchema;
  }

  private executeSql<T>(
    sql: string,
    bind: readonly unknown[] | undefined,
    loggerLevel: QueryMetaOpts["loggerLevel"],
    skipAfterMutatingStatement: boolean,
  ): ExecuteResult<T> {
    const perf = startPerformanceLogger(this.logger, loggerLevel);
    const driver = this.ensureDriver;
    const statement = driver.prepare(sql);
    let transaction: { commit: () => void; rollback: () => void } | undefined;

    try {
      const afterMutatingStatement =
        !skipAfterMutatingStatement && this.afterMutatingStatement && !this.isReadonlyStatement(statement, sql)
          ? this.afterMutatingStatement
          : null;

      let totalChangesBefore = 0;
      if (afterMutatingStatement) {
        transaction = this.beginStatementTransaction();
        totalChangesBefore = driver.totalChanges();
      }

      const rows = toRowObjects<T>(statement.run(bind ?? []), () => Object.create(null));
      statement.finalize();
      perf.logEnd(`${this.loggerPrefix ?? ""}:query`, sql, loggerLevel);

      if (transaction) {
        // Nothing was written, so the statement cannot have produced any work for the callback.
        if (driver.totalChanges() !== totalChangesBefore) {
          afterMutatingStatement?.(this);
        }
        transaction.commit();
      }

      return { rows };
    } catch (error) {
      statement.finalize();
      transaction?.rollback();
      throw error;
    }
  }

  private isReadonlyStatement(statement: SqliteDriverStatement, sql: string) {
    if (statement.readonly !== undefined) {
      return statement.readonly;
    }

    let readonly = this.readonlyStatementCache.get(sql);
    if (readonly === undefined) {
      readonly = TRANSACTION_CONTROL_PATTERN.test(sql) || this.isReadonlyByTablesUsed(sql);
      this.readonlyStatementCache.set(sql, readonly);
    }
    return readonly;
  }

  private isReadonlyByTablesUsed(sql: string) {
    // Statements that open no b-tree (PRAGMAs, table-less selects, full-table deletes)
    // are reported with no rows, so they are treated as writes.
    const tables = this.executePreparedRaw<[string], { wr: number }>({
      key: "$tables-used-writes",
      sql: `select "wr" from tables_used(?)`,
      params: [sql],
      meta: { loggerLevel: "system" },
    });
    return tables.length > 0 && tables.every((table) => !table.wr);
  }

  execute<T = unknown>(opts: ExecuteParams | string | CompiledQuery<T>, options?: ExecuteOptions): ExecuteResult<T> {
    const sql = typeof opts === "string" ? opts : opts.sql;
    const bind = typeof opts === "string" ? undefined : opts.parameters;

    return this.executeSql<T>(sql, bind, options?.loggerLevel, options?.skipAfterMutatingStatement ?? false);
  }

  setAfterMutatingStatement(callback: AfterMutatingStatement<TDatabase>) {
    if (this.afterMutatingStatement) {
      throw new Error("An afterMutatingStatement callback is already registered");
    }
    this.afterMutatingStatement = callback;
  }

  executeTransaction<T>(callback: (db: SQLiteTransactionWrapper<TDatabase>) => T): T {
    const transaction = this.beginTransaction();
    try {
      const result = callback(this);
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  beginTransaction() {
    this.executePreparedRaw({
      key: "$begin-transaction",
      sql: "begin",
      meta: {
        loggerLevel: "system",
      },
    });

    return {
      commit: () => {
        this.executePreparedRaw({
          key: "$commit-transaction",
          sql: "commit",
          meta: {
            loggerLevel: "system",
          },
        });
      },
      rollback: () => {
        this.executePreparedRaw({
          key: "$rollback-transaction",
          sql: "rollback",
          meta: {
            loggerLevel: "system",
          },
        });
      },
    };
  }

  // A savepoint opens a transaction when none is active, so this nests inside user transactions too.
  private beginStatementTransaction() {
    this.executePreparedRaw({
      key: "$begin-statement-savepoint",
      sql: "savepoint sqlite_sync_statement",
      meta: { loggerLevel: "system" },
    });

    return {
      commit: () => {
        this.executePreparedRaw({
          key: "$commit-statement-savepoint",
          sql: "release savepoint sqlite_sync_statement",
          meta: { loggerLevel: "system" },
        });
      },
      rollback: () => {
        this.executePreparedRaw({
          key: "$rollback-statement-savepoint",
          sql: "rollback to savepoint sqlite_sync_statement",
          meta: { loggerLevel: "system" },
        });
        this.executePreparedRaw({
          key: "$release-rolled-back-statement-savepoint",
          sql: "release savepoint sqlite_sync_statement",
          meta: { loggerLevel: "system" },
        });
      },
    };
  }

  prepare<TParams extends unknown[], TResult>(sql: string, opts?: QueryMetaOpts) {
    const perf = startPerformanceLogger(this.logger, opts?.loggerLevel);
    const stmt = this.ensureDriver.prepare(sql);
    perf.logEnd(`${this.loggerPrefix ?? ""}:prepare`, sql, opts?.loggerLevel);

    let isFinalized = false;

    const execute = (params: TParams) => {
      if (isFinalized) {
        throw new Error("Statement is finalized");
      }

      const perf = startPerformanceLogger(this.logger, opts?.loggerLevel);
      try {
        return toRowObjects<TResult>(stmt.run(params), () => ({}));
      } finally {
        perf.logEnd(`${this.loggerPrefix ?? ""}:prepare-execute`, sql, opts?.loggerLevel);
      }
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

    this.preparedStatements.push(preparedStatement as PreparedStatement<SqliteDriverValue[], unknown>);

    return preparedStatement;
  }

  prepareKysely<TParams extends Record<string, unknown>>(opts?: QueryMetaOpts) {
    return <TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
      factory: KyselyStatementFactory<TParams, TDatabase, TQuery, TResult>,
    ): TypedStatement<TParams, TResult> => {
      const query = compileKyselyStatement(factory);
      const statement = this.prepare<SqliteDriverValue[], TResult>(query.sql, opts);

      return {
        execute: (parameters) => statement.execute(query.bindParameters(parameters) as SqliteDriverValue[]),
      };
    };
  }

  executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
    factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
    options?: ExecuteOptions,
  ) {
    const query = factory(dummyKysely).compile();
    return this.execute(query, options);
  }

  executePrepared<
    TParams extends Record<string, unknown>,
    TQuery extends Compilable<TResult>,
    TResult = QueryBuilderOutput<TQuery>,
  >(
    key: string,
    params: TParams,
    factory: KyselyStatementFactory<TParams, TDatabase, TQuery, TResult>,
    meta?: QueryMetaOpts,
  ) {
    let statement = this.preparedStatementsMap.get(key) as TypedStatement<TParams, TResult> | undefined;
    if (!statement) {
      statement = this.prepareKysely<TParams>(meta)(factory);
      this.preparedStatementsMap.set(key, statement as TypedStatement<Record<string, unknown>, unknown>);
    }

    return statement.execute(params);
  }

  executePreparedRaw<TParams extends unknown[], TResult>({
    key,
    sql,
    params,
    meta,
  }: {
    key: string;
    sql: string;
    params?: TParams;
    meta?: QueryMetaOpts;
  }) {
    let statement = this.preparedRawStatementsMap.get(key) as PreparedStatement<TParams, TResult> | undefined;
    if (!statement) {
      statement = this.prepare(sql, meta);
      this.preparedRawStatementsMap.set(key, statement as PreparedStatement<any[], unknown>);
    }

    return statement.execute((params ?? []) as TParams);
  }

  sql<T = unknown>(templateOrString: TemplateStringsArray | string, ...parameters: unknown[]) {
    if (typeof templateOrString === "string") {
      return this.execute<T>({
        sql: templateOrString,
        parameters,
      });
    }
    return this.execute<T>({
      sql: templateOrString.join("?"),
      parameters,
    });
  }

  createScalarFunction<TArgs extends SqliteDriverValue[], TResult extends SqliteDriverValue | undefined>({
    name,
    callback,
    deterministic,
    directOnly,
    innocuous,
  }: ScalarFunctionOptions<TArgs, TResult>) {
    const driver = this.ensureDriver;
    if (!driver.createScalarFunction) {
      throw new Error("This SQLite driver does not support scalar functions");
    }
    driver.createScalarFunction({
      name,
      callback: (...args) => callback(...(args as TArgs)),
      arity: callback.length,
      deterministic,
      directOnly,
      innocuous,
    });
  }

  useSnapshot(snapshot: Uint8Array<ArrayBufferLike>) {
    const perf = startPerformanceLogger(this.logger, "system");
    const driver = this.ensureDriver;
    if (!driver.deserialize) {
      throw new Error("This SQLite driver does not support snapshots");
    }
    driver.deserialize(snapshot);

    this.invalidateDbSchema();

    perf.logEnd("useSnapshot", "success", "system");
  }

  createSnapshot() {
    const driver = this.ensureDriver;
    if (!driver.serialize) {
      throw new Error("This SQLite driver does not support snapshots");
    }
    return driver.serialize();
  }

  invalidateDbSchema() {
    this.loadedDbSchema = null;
  }

  cleanup() {
    this.preparedStatements.forEach((stmt) => {
      stmt.finalize();
    });
    this.preparedStatements.splice(0);
    this.preparedStatementsMap.clear();
    this.preparedRawStatementsMap.clear();
    this.readonlyStatementCache.clear();
  }

  close() {
    this.cleanup();

    this.driver?.close();
    this.driver = null;
  }
}

function toRowObjects<T>(
  { columns, rows }: { columns: string[]; rows: SqliteDriverValue[][] },
  createRow: () => Record<string, unknown>,
): T[] {
  const result: T[] = [];
  for (const values of rows) {
    const row = createRow();
    for (let index = 0; index < columns.length; index++) {
      row[columns[index]] = values[index];
    }
    result.push(row as T);
  }
  return result;
}

export type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;
type ParamsGetter<TParams> = <TKey extends keyof TParams>(key: TKey) => TParams[TKey];

type TypedStatement<TParams extends Record<string, unknown>, TResult> = {
  execute: (parameters: TParams) => TResult[];
};
export type KyselyStatementFactory<
  TParams extends Record<string, unknown>,
  TDatabase,
  TQuery extends Compilable<TResult>,
  TResult = QueryBuilderOutput<TQuery>,
> = (kysely: Kysely<TDatabase>, params: ParamsGetter<TParams>) => TQuery;
export type KyselyQueryFactory<TDatabase, TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>> = (
  kysely: Kysely<TDatabase>,
) => TQuery;

export function compileKyselyStatement<TParams extends Record<string, unknown>, TDatabase>(
  factory: KyselyStatementFactory<TParams, TDatabase, Compilable<unknown>>,
) {
  const parameterKeys = new Map<unknown, keyof TParams>();
  const query = factory(dummyKysely, (key) => {
    const token = {};
    parameterKeys.set(token, key);
    return token as TParams[typeof key];
  }).compile();

  return {
    sql: query.sql,
    bindParameters: (parameters: TParams) =>
      query.parameters.map((value) => {
        const key = parameterKeys.get(value);
        return key === undefined ? value : parameters[key];
      }),
  };
}
