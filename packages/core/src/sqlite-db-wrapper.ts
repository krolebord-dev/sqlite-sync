import type {
  BindableValue,
  FunctionOptions,
  Database as SQLiteDatabase,
  Sqlite3Static,
  SqlValue,
} from "@sqlite.org/sqlite-wasm";
import type { Compilable, CompiledQuery, Kysely } from "kysely";
import { dummyKysely } from "./dummy-kysely";
import { type DatabaseIntrospection, introspectDb } from "./introspection";
import { type Logger, startPerformanceLogger } from "./logger";

export type ExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

export type ExecuteResult<T> = {
  rows: T[];
};

export type PreparedStatement<TParams extends SqlValue[], TResult> = {
  execute: (parameters: TParams) => TResult[];
  finalize: () => void;
  isFinalized: boolean;
};

type ScalarFunctionOptions<TArgs extends readonly SqlValue[], TResult extends SqlValue | undefined> = {
  name: string;
  callback: (...args: TArgs) => TResult;
} & Pick<FunctionOptions, "deterministic" | "directOnly" | "innocuous">;

type SqliteWrapperOptions = {
  logger?: Logger;
  loggerPrefix?: string;
  sqlite3: Sqlite3Static;
  db: () => SQLiteDatabase;
};

export type SQLiteTransactionWrapper<TDatabase = unknown> = Pick<
  SQLiteDbWrapper<TDatabase>,
  "execute" | "sql" | "executeKysely" | "prepare" | "executePrepared" | "prepareKysely"
>;

type QueryMetaOpts = {
  loggerLevel?: "info" | "system";
};

export class SQLiteDbWrapper<TDatabase = unknown> {
  private db: SQLiteDatabase | null = null;
  private sqlite3: Sqlite3Static;
  private logger?: Logger;
  private loggerPrefix?: string;

  private loadedDbSchema: DatabaseIntrospection | null = null;

  private readonly dataPointers = [] as number[];

  private preparedStatements: PreparedStatement<SqlValue[], unknown>[] = [];
  private preparedStatementsMap = new Map<string, TypedStatement<Record<string, unknown>, unknown>>();
  private preparedRawStatementsMap = new Map<string, PreparedStatement<SqlValue[], unknown>>();

  constructor(opts: SqliteWrapperOptions) {
    this.db = opts.db();
    this.sqlite3 = opts.sqlite3;
    this.logger = opts.logger;
    this.loggerPrefix = opts.loggerPrefix;
  }

  get ensureDb() {
    if (!this.db) {
      throw new Error("Database is already closed");
    }
    return this.db;
  }

  get dbSchema() {
    if (!this.loadedDbSchema) {
      this.loadedDbSchema = introspectDb(this);
    }
    return this.loadedDbSchema;
  }

  execute<T = unknown>(opts: ExecuteParams | string | CompiledQuery<T>, meta?: QueryMetaOpts): ExecuteResult<T> {
    const sql = typeof opts === "string" ? opts : opts.sql;
    const bind = typeof opts === "string" ? undefined : opts.parameters;

    const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
    const rows = this.ensureDb.exec({
      sql,
      bind: bind as BindableValue[],
      returnValue: "resultRows",
      rowMode: "object",
    });
    perf?.logEnd(`${this.loggerPrefix ?? ""}:query`, sql, meta?.loggerLevel);

    return { rows: rows as T[] };
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

  isInTransaction() {
    // TODO: Awaiting upstream fix: https://github.com/sqlite/sqlite-wasm/pull/143
    return (this.sqlite3.capi as any).sqlite3_get_autocommit(this.ensureDb) === 0;
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

  prepare<TParams extends SqlValue[], TResult>(sql: string, opts?: QueryMetaOpts) {
    const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
    const stmt = this.ensureDb.prepare(sql);
    perf?.logEnd(`${this.loggerPrefix ?? ""}:prepare`, sql, opts?.loggerLevel);

    let isFinalized = false;

    const execute = (params: TParams) => {
      if (isFinalized) {
        throw new Error("Statement is finalized");
      }

      const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results = [] as TResult[];
      while (stmt.step()) {
        results.push(stmt.get({}) as TResult);
      }
      stmt.reset(true);
      perf?.logEnd(`${this.loggerPrefix ?? ""}:prepare-execute`, sql, opts?.loggerLevel);
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

    this.preparedStatements.push(preparedStatement as PreparedStatement<SqlValue[], unknown>);

    return preparedStatement;
  }

  prepareKysely<TParams extends Record<string, unknown>>(opts?: QueryMetaOpts) {
    return <TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
      factory: KyselyStatementFactory<TParams, TDatabase, TQuery, TResult>,
    ): TypedStatement<TParams, TResult> => {
      const query = factory(dummyKysely, (key) => key as any).compile();
      const statement = this.prepare<SqlValue[], TResult>(query.sql, opts);

      return {
        execute: (parameters) => {
          const params = query.parameters.map((param) => parameters[param as keyof TParams]);
          const result = statement.execute(params as SqlValue[]);
          return result;
        },
      };
    };
  }

  executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
    factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
    meta?: QueryMetaOpts,
  ) {
    const query = factory(dummyKysely).compile();
    return this.execute(query, meta);
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

  executePreparedRaw<TParams extends SqlValue[], TResult>({
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

  createScalarFunction<TArgs extends SqlValue[], TResult extends SqlValue | undefined>({
    name,
    callback,
    deterministic,
    directOnly,
    innocuous,
  }: ScalarFunctionOptions<TArgs, TResult>) {
    return this.ensureDb.createFunction({
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

  useSnapshot(snapshot: Uint8Array<ArrayBufferLike>) {
    const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
    const dataPointer = this.sqlite3.wasm.allocFromTypedArray(snapshot);
    this.dataPointers.push(dataPointer);

    const resultCode = this.sqlite3.capi.sqlite3_deserialize(
      this.ensureDb,
      "main",
      dataPointer,
      snapshot.byteLength,
      snapshot.byteLength,
      this.sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | this.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );

    this.ensureDb.checkRc(resultCode);

    this.invalidateDbSchema();

    perf?.logEnd("useSnapshot", "success", "system");
  }

  createSnapshot() {
    return this.sqlite3.capi.sqlite3_js_db_export(this.ensureDb);
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
  }

  close() {
    this.cleanup();

    this.db?.close();
    this.db = null;
  }
}

export type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;
type ParamsGetter<TParams> = <TKey extends keyof TParams>(key: TKey) => TParams[TKey];

type TypedStatement<TParams extends Record<string, unknown>, TResult> = {
  execute: (parameters: TParams) => TResult[];
};
type KyselyStatementFactory<
  TParams extends Record<string, unknown>,
  TDatabase,
  TQuery extends Compilable<TResult>,
  TResult = QueryBuilderOutput<TQuery>,
> = (kysely: Kysely<TDatabase>, params: ParamsGetter<TParams>) => TQuery;
export type KyselyQueryFactory<TDatabase, TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>> = (
  kysely: Kysely<TDatabase>,
) => TQuery;
