import type { ExecuteParams, SyncDbSchema, SyncedDb, WorkerState } from "@sqlite-sync/core";
import { dummyKysely } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";
import { createContext, use, useCallback, useMemo, useRef, useSyncExternalStore } from "react";

type DbQueryParams<Database, TResult> =
  | Compilable<TResult>
  | ((kysely: Kysely<Database>) => Compilable<TResult>)
  | ExecuteParams;

type UseDbQueryOptions<TResult, TMapResult = TResult> = {
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

  const useDbQuery = <TResult, TMapResult = TResult[]>(
    query: DbQueryParams<Schema["~clientSchema"], TResult>,
    { mapData }: UseDbQueryOptions<TResult, TMapResult> = {},
  ) => {
    const db = useDb();

    const { sql, parameters } = resolveQuery(query);

    // biome-ignore lint/correctness/useExhaustiveDependencies: initial parameters should only change when the query changes
    const liveQuery = useMemo(() => {
      return db.reactiveDb.createLiveQuery<TResult>({
        sql,
        parameters,
      });
    }, [db, sql]);

    const lastRef = useRef<{ db: unknown; sql: string; parameters: readonly unknown[] }>({
      db,
      sql,
      parameters,
    });
    if (
      lastRef.current.db === db &&
      lastRef.current.sql === sql &&
      !parametersAreEqual(lastRef.current.parameters, parameters)
    ) {
      liveQuery.refresh(parameters);
    }
    lastRef.current = { db, sql, parameters };

    const data = useSyncExternalStore(liveQuery.subscribe, liveQuery.getRows);

    const mapDataRef = useRef(mapData);
    mapDataRef.current = mapData;

    const mappedData = useMemo(() => {
      return mapDataRef.current ? mapDataRef.current(data) : data;
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

function resolveQuery<Database, TResult>(query: DbQueryParams<Database, TResult>): ExecuteParams {
  if (typeof query === "function") {
    return query(dummyKysely).compile();
  } else if (typeof query === "object" && "compile" in query) {
    return query.compile();
  } else {
    return query;
  }
}

function parametersAreEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a?.length !== b?.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      return false;
    }
  }
  return true;
}
