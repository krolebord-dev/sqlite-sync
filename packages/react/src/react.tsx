import type { SyncedDb } from "@sqlite-sync/core";
import { dummyKysely } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";
import { createContext, use, useMemo, useSyncExternalStore } from "react";

type UseDbQueryOptions<TParams extends readonly unknown[] | undefined, TResult, Database> = {
  parameters?: TParams;
  queryFn: (kysely: Kysely<Database>, keys: TParams) => Compilable<TResult>;
};

export function createDbContext<Database>() {
  const dbContext = createContext<SyncedDb<Database> | null>(null);

  const useDb = () => {
    const db = use(dbContext);
    if (!db) {
      throw new Error("Database not found");
    }
    return db;
  };

  const DbProvider = ({ children, db }: { children: React.ReactNode; db: SyncedDb<Database> }) => {
    return <dbContext.Provider value={db}>{children}</dbContext.Provider>;
  };

  const useDbQuery = <TResult, TParams extends readonly unknown[] | undefined = undefined>({
    parameters,
    queryFn,
  }: UseDbQueryOptions<TParams, TResult, Database>) => {
    const db = useDb();

    const compiledQuery = useMemo(() => {
      return queryFn(dummyKysely, parameters as TParams).compile();
    }, [parameters, queryFn]);

    const liveQuery = useMemo(() => {
      return db.reactiveDb.createLiveQuery<TResult>({
        sql: compiledQuery.sql,
        parameters: compiledQuery.parameters,
      });
    }, [db, compiledQuery]);

    const rows = useSyncExternalStore(liveQuery.subscribe, liveQuery.getRows);

    return { rows, refresh: liveQuery.refresh };
  };

  return { useDb, DbProvider, useDbQuery };
}
