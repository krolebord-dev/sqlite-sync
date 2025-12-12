import type {
  BindableValue,
  FunctionOptions,
  Sqlite3Static,
  Database as SQLiteDatabase,
  SqlValue,
} from "@sqlite.org/sqlite-wasm";
import { startPerformanceLogger, type Logger } from "./logger";
import { Kysely, type Compilable, type CompiledQuery } from "kysely";
import { dummyKysely } from "./dummy-kysely";
import { introspectDb, type DatabaseIntrospection } from "./introspection";

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

type ScalarFunctionOptions<
  TArgs extends readonly SqlValue[],
  TResult extends SqlValue | void
> = {
  name: string;
  callback: (...args: TArgs) => TResult;
} & Pick<FunctionOptions, "deterministic" | "directOnly" | "innocuous">;

type SqliteWrapperOptions = {
  logger?: Logger;
  loggerPrefix?: string;
  sqlite3: Sqlite3Static;
  db: SQLiteDatabase;
};

export type SQLiteTransactionWrapper<TDatabase = unknown> = Pick<
  SQLiteDbWrapper<TDatabase>,
  | "execute"
  | "sql"
  | "executeKysely"
  | "prepare"
  | "executePrepared"
  | "prepareKysely"
>;

export class SQLiteDbWrapper<TDatabase = unknown> {
  private db: SQLiteDatabase | null = null;
  private sqlite3: Sqlite3Static;
  private logger?: Logger;
  private loggerPrefix?: string;

  private loadedDbSchema: DatabaseIntrospection | null = null;

  private readonly dataPointers = [] as number[];

  private preparedStatements: PreparedStatement<SqlValue[], unknown>[] = [];
  private preparedStatementsMap = new Map<
    string,
    TypedStatement<Record<string, unknown>, unknown>
  >();

  constructor(opts: SqliteWrapperOptions) {
    this.db = opts.db;
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

  execute<T = unknown>(
    opts: ExecuteParams | string | CompiledQuery<T>
  ): ExecuteResult<T> {
    const sql = typeof opts === "string" ? opts : opts.sql;
    const bind = typeof opts === "string" ? undefined : opts.parameters;

    const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
    const rows = this.ensureDb.exec({
      sql,
      bind: bind as BindableValue[],
      returnValue: "resultRows",
      rowMode: "object",
    });
    perf?.logEnd(`${this.loggerPrefix ?? ""}:query`, sql, "info");

    return { rows: rows as T[] };
  }

  executeTransaction<T>(
    callback: (db: SQLiteTransactionWrapper<TDatabase>) => T
  ): T {
    return this.ensureDb.transaction(() => callback(this));
  }

  prepare<TParams extends SqlValue[], TResult>(sql: string) {
    const perf = this.logger ? startPerformanceLogger(this.logger) : undefined;
    const stmt = this.ensureDb.prepare(sql);
    perf?.logEnd(`${this.loggerPrefix ?? ""}:prepare`, sql, "info");

    let isFinalized = false;

    const execute = (params: TParams) => {
      if (isFinalized) {
        throw new Error("Statement is finalized");
      }

      const perf = this.logger
        ? startPerformanceLogger(this.logger)
        : undefined;
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results = [] as TResult[];
      while (stmt.step()) {
        results.push(stmt.get({}) as TResult);
      }
      stmt.reset(true);
      perf?.logEnd(`${this.loggerPrefix ?? ""}:prepare-execute`, sql, "info");
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

  prepareKysely<TParams extends Record<string, unknown>>() {
    return <
      TQuery extends Compilable<TResult>,
      TResult = QueryBuilderOutput<TQuery>
    >(
      factory: KyselyStatementFactory<TParams, TDatabase, TQuery, TResult>
    ): TypedStatement<TParams, TResult> => {
      const query = factory(dummyKysely, (key) => key as any).compile();
      const statement = this.prepare<SqlValue[], TResult>(query.sql);

      return {
        execute: (parameters) => {
          const params = query.parameters.map(
            (param) => parameters[param as keyof TParams]
          );
          const result = statement.execute(params as SqlValue[]);
          return result;
        },
      };
    };
  }

  executeKysely<
    TQuery extends Compilable<TResult>,
    TResult = QueryBuilderOutput<TQuery>
  >(factory: KyselyQueryFactory<TDatabase, TQuery, TResult>) {
    const query = factory(dummyKysely).compile();
    return this.execute(query);
  }

  executePrepared<
    TParams extends Record<string, unknown>,
    TQuery extends Compilable<TResult>,
    TResult = QueryBuilderOutput<TQuery>
  >(
    key: string,
    params: TParams,
    factory: KyselyStatementFactory<TParams, TDatabase, TQuery, TResult>
  ) {
    let statement = this.preparedStatementsMap.get(key) as
      | TypedStatement<TParams, TResult>
      | undefined;
    if (!statement) {
      statement = this.prepareKysely<TParams>()(factory);
      this.preparedStatementsMap.set(
        key,
        statement as TypedStatement<Record<string, unknown>, unknown>
      );
    }

    return statement.execute(params);
  }

  sql<T = unknown>(
    templateOrString: TemplateStringsArray | string,
    ...parameters: unknown[]
  ) {
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

  createScalarFunction<
    TArgs extends SqlValue[],
    TResult extends SqlValue | void
  >({
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
      this.sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        this.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );

    this.ensureDb.checkRc(resultCode);

    this.invalidateDbSchema();

    perf?.logEnd("useSnapshot", "success", "info");
  }

  createSnapshot() {
    return this.sqlite3.capi.sqlite3_js_db_export(this.ensureDb);
  }

  invalidateDbSchema() {
    this.loadedDbSchema = null;
  }

  cleanup() {
    this.preparedStatements.forEach((stmt) => stmt.finalize());
    this.preparedStatements.splice(0);
    this.preparedStatementsMap.clear();
  }

  close() {
    this.cleanup();

    this.db?.close();
    this.db = null;
  }
}

export type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;
type ParamsGetter<TParams> = <TKey extends keyof TParams>(
  key: TKey
) => TParams[TKey];

type TypedStatement<TParams extends Record<string, unknown>, TResult> = {
  execute: (parameters: TParams) => TResult[];
};
type KyselyStatementFactory<
  TParams extends Record<string, unknown>,
  TDatabase,
  TQuery extends Compilable<TResult>,
  TResult = QueryBuilderOutput<TQuery>
> = (kysely: Kysely<TDatabase>, params: ParamsGetter<TParams>) => TQuery;
export type KyselyQueryFactory<
  TDatabase,
  TQuery extends Compilable<TResult>,
  TResult = QueryBuilderOutput<TQuery>
> = (kysely: Kysely<TDatabase>) => TQuery;

