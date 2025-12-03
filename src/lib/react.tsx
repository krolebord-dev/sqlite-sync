import { createContext, use, useMemo, useSyncExternalStore } from "react";
import type { SyncedDb } from "./sync-db";
import type { CompiledQuery, Kysely } from "kysely";

type UseDbQueryOptions<
  TParams extends readonly unknown[] | undefined,
  TResult,
  Database
> = {
  parameters?: TParams;
  queryFn: (kysely: Kysely<Database>, keys: TParams) => CompiledQuery<TResult>;
};

export function createDbContext<Database>() {
  const dbContext = createContext<SyncedDb<Database>>(null!);

  const useDb = () => {
    const db = use(dbContext);
    if (!db) {
      throw new Error("Database not found");
    }
    return db;
  };

  const DbProvider = ({
    children,
    db,
  }: {
    children: React.ReactNode;
    db: SyncedDb<Database>;
  }) => {
    return <dbContext.Provider value={db}>{children}</dbContext.Provider>;
  };

  const useDbQuery = <
    TResult,
    TParams extends readonly unknown[] | undefined = undefined
  >({
    parameters,
    queryFn,
  }: UseDbQueryOptions<TParams, TResult, Database>) => {
    const db = useDb();

    const compiledQuery = useMemo(() => {
      return queryFn(db.memoryDb.kysely, parameters as TParams);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, ...(parameters ?? [])]);

    const liveQuery = useMemo(() => {
      return db.memoryDb.createLiveQuery<TResult>({
        sql: compiledQuery.sql,
        parameters: compiledQuery.parameters,
      });
    }, [db, compiledQuery]);

    const rows = useSyncExternalStore(liveQuery.subscribe, liveQuery.getRows);

    return { rows, refresh: liveQuery.refresh };
  };

  return { useDb, DbProvider, useDbQuery };
}
