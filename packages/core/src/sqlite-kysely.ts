import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type {} from "@sqlite.org/sqlite-wasm";

type SqliteDatabase = {
  execute: (opts: { sql: string; parameters: readonly unknown[] }) => {
    rows: unknown[];
  };
  close: () => void;
};

export class SqliteDriver implements Driver {
  readonly #connectionMutex = new ConnectionMutex();

  #db: SqliteDatabase;
  #connection: DatabaseConnection;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#connection = new SqliteConnection(this.#db);
  }

  async init(): Promise<void> {
    return Promise.resolve();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#connectionMutex.lock();
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    this.#connectionMutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
  }
}

class SqliteConnection implements DatabaseConnection {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const stmt = this.#db.execute(compiledQuery);

    return Promise.resolve({
      rows: stmt.rows as O[],
    });
  }

  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncGenerator<never, void, unknown> {
    throw new Error("SQLite3 does not support streaming.");
  }
}

class ConnectionMutex {
  #promise?: Promise<void>;
  #resolve?: () => void;

  async lock(): Promise<void> {
    while (this.#promise) {
      await this.#promise;
    }

    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;

    this.#promise = undefined;
    this.#resolve = undefined;

    resolve?.();
  }
}

export function createSQLiteKysely<Database>(sqliteDb: SqliteDatabase) {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new SqliteDriver(sqliteDb),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

