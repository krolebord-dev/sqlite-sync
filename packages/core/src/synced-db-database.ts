import type { Compilable, CompiledQuery } from "kysely";
import type { SharedLiveQuery, SQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import type {
  ExecuteParams,
  ExecuteResult,
  KyselyQueryFactory,
  QueryBuilderOutput,
  SQLiteTransactionWrapper,
} from "./sqlite-db-wrapper";

/** SQL execution that participates in CRDT intent draining. */
export type SyncedDbSqlExecutor<Database> = {
  execute<TResult = unknown>(query: ExecuteParams | string | CompiledQuery<TResult>): ExecuteResult<TResult>;
  executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
    factory: KyselyQueryFactory<Database, TQuery, TResult>,
  ): ExecuteResult<TResult>;
};

/**
 * SQL execution that deliberately bypasses CRDT intent draining.
 *
 * Mutating a synced view through this executor can leave undrained intents and
 * must only be done by sqlite-sync internals or recovery tooling.
 */
export type UnsafeSyncedDbSqlExecutor<Database> = SyncedDbSqlExecutor<Database>;

export type SyncedDbTransaction<Database> = SyncedDbSqlExecutor<Database> & {
  unsafe: UnsafeSyncedDbSqlExecutor<Database>;
  sql<TResult = unknown>(
    templateOrString: TemplateStringsArray | string,
    ...parameters: unknown[]
  ): ExecuteResult<TResult>;
};

export type SyncedDbDatabase<Database> = SyncedDbSqlExecutor<Database> & {
  unsafe: UnsafeSyncedDbSqlExecutor<Database>;
  executeTransaction<TResult>(callback: (tx: SyncedDbTransaction<Database>) => TResult): TResult;
  createLiveQuery<TResult>(query: { sql: string; parameters: readonly unknown[] }): {
    getRows: () => TResult[];
    refresh: (parameters?: readonly unknown[]) => void;
    subscribe: (onchange: () => void) => () => void;
  };
  getSharedLiveQuery<TResult>(query: { sql: string; parameters: readonly unknown[] }): SharedLiveQuery<TResult>;
};

function createSqlExecutor<Database>(
  tx: Pick<SQLiteTransactionWrapper<Database>, "execute" | "executeKysely">,
  unsafe: boolean,
): SyncedDbSqlExecutor<Database> {
  return {
    execute: (query) => tx.execute(query, unsafe ? { skipAfterMutatingStatement: true } : undefined),
    executeKysely: (factory) => tx.executeKysely(factory, unsafe ? { skipAfterMutatingStatement: true } : undefined),
  };
}

/** @internal Exported for focused facade tests, but not from the package entry point. */
export function createSyncedDbDatabase<Database>(reactiveDb: SQLiteReactiveDb<Database>): SyncedDbDatabase<Database> {
  const safeExecutor = createSqlExecutor(reactiveDb.db, false);
  const unsafeExecutor = createSqlExecutor(reactiveDb.db, true);

  return {
    ...safeExecutor,
    unsafe: unsafeExecutor,
    executeTransaction: (callback) =>
      reactiveDb.db.executeTransaction((tx) => {
        const safeTransactionExecutor = createSqlExecutor(tx, false);
        const unsafeTransactionExecutor = createSqlExecutor(tx, true);
        return callback({
          ...safeTransactionExecutor,
          unsafe: unsafeTransactionExecutor,
          sql: tx.sql.bind(tx),
        });
      }),
    createLiveQuery: reactiveDb.createLiveQuery.bind(reactiveDb),
    getSharedLiveQuery: reactiveDb.getSharedLiveQuery.bind(reactiveDb),
  };
}
