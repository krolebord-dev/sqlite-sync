import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type { BindableValue } from "@sqlite.org/sqlite-wasm";

type MemoryDb = {
  execute: (opts: { sql: string; params: BindableValue[] }) => {
    rows: unknown[];
  };
  close: () => void;
};

export class SQLiteMemoryDriver implements Driver {
  private db: MemoryDb;

  constructor(db: MemoryDb) {
    this.db = db;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<SQLiteMemoryConnection> {
    return new SQLiteMemoryConnection(this.db);
  }

  async releaseConnection(): Promise<void> {}

  async beginTransaction(): Promise<void> {
    throw new Error("SQLite3 does not support interactive transactions.");
  }

  async commitTransaction(): Promise<void> {
    throw new Error("SQLite3 does not support interactive transactions.");
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error("SQLite3 does not support interactive transactions.");
  }

  async destroy(): Promise<void> {
    this.db.close();
  }
}

class SQLiteMemoryConnection implements DatabaseConnection {
  private db: MemoryDb;

  constructor(db: MemoryDb) {
    this.db = db;
  }

  async executeQuery<Result>(
    query: CompiledQuery
  ): Promise<QueryResult<Result>> {
    const { rows } = this.db.execute({
      sql: query.sql,
      params: query.parameters as BindableValue[],
    });

    return {
      rows: rows as Result[],
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncGenerator<never, void, unknown> {
    throw new Error("SQLite3 does not support streaming.");
  }
}

export function createSQLiteMemoryKysely<Database>(memoryDb: MemoryDb) {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new SQLiteMemoryDriver(memoryDb),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}
