import { dummyKysely } from "@sqlite-sync/core";
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
    const rows = db.sql.exec(query.sql, ...query.parameters).toArray();
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
