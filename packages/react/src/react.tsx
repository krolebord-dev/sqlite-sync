import type { SyncDbSchema, SyncedDb, WorkerState } from "@sqlite-sync/core";
import { dummyKysely } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";
import { createContext, use, useCallback, useMemo, useSyncExternalStore } from "react";

type UseDbQueryOptions<TParams extends readonly unknown[] | undefined, Database, TResult, TMapResult = TResult> = {
  parameters?: TParams;
  queryFn: (kysely: Kysely<Database>, keys: TParams) => Compilable<TResult>;
  mapData?: (data: TResult[]) => TMapResult;
};

export function createDbContext<Schema extends SyncDbSchema>(_: Schema) {
  const dbContext = createContext<SyncedDb<Schema["~clientSchema"]> | null>(null);

  const useDb = () => {
    const db = use(dbContext);
    if (!db) {
      throw new Error("Database not found");
    }
    return db;
  };

  const DbProvider = ({ children, db }: { children: React.ReactNode; db: SyncedDb<Schema["~clientSchema"]> }) => {
    return <dbContext.Provider value={db}>{children}</dbContext.Provider>;
  };

  const useDbQuery = <TResult, TMapResult = TResult[], TParams extends readonly unknown[] | undefined = undefined>({
    parameters,
    queryFn,
    mapData,
  }: UseDbQueryOptions<TParams, Schema["~clientSchema"], TResult, TMapResult>) => {
    const db = useDb();

    // biome-ignore lint/correctness/useExhaustiveDependencies: parameters is a dependency of the query
    const compiledQuery = useMemo(() => {
      return queryFn(dummyKysely, parameters as TParams).compile();
    }, [...(parameters ?? [])]);

    const liveQuery = useMemo(() => {
      return db.reactiveDb.createLiveQuery<TResult>({
        sql: compiledQuery.sql,
        parameters: compiledQuery.parameters,
      });
    }, [db, compiledQuery]);

    const data = useSyncExternalStore(liveQuery.subscribe, liveQuery.getRows);

    // biome-ignore lint/correctness/useExhaustiveDependencies: mapData is a dependency of the mapped data
    const mappedData = useMemo(() => {
      return mapData ? mapData(data) : data;
    }, [data]) as TMapResult;

    return { data: mappedData, refresh: liveQuery.refresh };
  };

  const useDbState = (): WorkerState => {
    const db = useDb();

    const subscribeToDbState = useCallback(
      (onChange: () => void) => {
        db.workerDb.addEventListener("state-changed", onChange);
        return () => {
          db.workerDb.removeEventListener("state-changed", onChange);
        };
      },
      [db],
    );

    return useSyncExternalStore<WorkerState>(subscribeToDbState, () => db.workerDb.getState());
  };

  return { useDb, DbProvider, useDbQuery, useDbState };
}
