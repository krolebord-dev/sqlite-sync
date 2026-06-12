import { dummyKysely, type InternalSQLiteWrapper, type KyselyStatementFactory } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";

type ExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

type ExecuteResult<T> = {
  rows: T[];
};

type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;

type KyselyQueryFactory<TDatabase, TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>> = (
  kysely: Kysely<TDatabase>,
) => TQuery;

export type KyselyExecutor<TDatabase> = {
  execute<TResult = unknown>(query: ExecuteParams): ExecuteResult<TResult>;
  executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
    factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
  ): ExecuteResult<TResult>;
  transaction: (callback: (tx: Pick<KyselyExecutor<TDatabase>, "execute" | "executeKysely">) => void) => void;
};

export function createKyselyExecutor<TDatabase>(db: DurableObjectStorage): KyselyExecutor<TDatabase> {
  const execute = <TResult = unknown>(query: ExecuteParams): ExecuteResult<TResult> => {
    // https://github.com/cloudflare/workers-sdk/issues/9964 - booleans are not coerced to 1/0 in DO SQL
    const parameters = query.parameters.map((param) => (typeof param === "boolean" ? (param ? 1 : 0) : param));
    const rows = db.sql.exec(query.sql, ...parameters).toArray();
    return { rows: rows as TResult[] };
  };

  const executeKysely = <TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
    factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
  ): ExecuteResult<TResult> => {
    const query = factory(dummyKysely as any).compile();
    return execute(query);
  };

  const transaction = (callback: (tx: Pick<KyselyExecutor<TDatabase>, "execute" | "executeKysely">) => void) => {
    db.transactionSync(() => callback(executor));
  };

  const executor = {
    execute,
    executeKysely,
    transaction,
  };

  return executor;
}

export function createCrdtStorageDb(executor: KyselyExecutor<any>): InternalSQLiteWrapper<any> {
  const wrapper: Omit<InternalSQLiteWrapper<any>, "executeTransaction"> = {
    executePreparedRaw: <TParams extends unknown[], TResult>({
      sql,
      params,
    }: {
      sql: string;
      params?: TParams | undefined;
    }) =>
      executor.execute<TResult>({
        sql,
        parameters: params ?? [],
      }).rows,

    executePrepared: <
      TParams extends Record<string, unknown>,
      TQuery extends Compilable<TResult>,
      TResult = QueryBuilderOutput<TQuery>,
    >(
      _: string,
      params: TParams,
      factory: KyselyStatementFactory<TParams, any, TQuery, TResult>,
    ) => {
      const query = factory(dummyKysely as any, (key) => key as any).compile();
      const parameters = query.parameters.map((param) => params[param as keyof TParams]);
      const result = executor.execute<TResult>({
        sql: query.sql,
        parameters,
      });
      return result.rows;
    },
  };

  return {
    ...wrapper,
    executeTransaction: (callback) =>
      executor.transaction(() => {
        callback(wrapper);
      }),
  };
}
