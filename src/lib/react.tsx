import {
  createContext,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import type { SyncedDb } from "./sync-db";
import type { CompiledQuery, Kysely } from "kysely";

type UseDbQueryOptions<
  TParams extends readonly unknown[] | undefined,
  TResult,
  Database
> = {
  params?: TParams;
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
    params,
    queryFn,
  }: UseDbQueryOptions<TParams, TResult, Database>) => {
    const db = useDb();

    const query = useMemo(
      () => {
        const compiledQuery = queryFn(db.memoryDb.kysely, params as TParams);
        const fetchRows = () =>
          db.memoryDb.execute<TResult>({
            sql: compiledQuery.sql,
            params: compiledQuery.parameters ?? [],
          }).rows;

        return {
          sql: compiledQuery.sql,
          params: compiledQuery.parameters as TParams,
          fetchRows,
        };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [db, ...(params ?? [])]
    );

    const [initialState] = useState(() => {
      return {
        query: query,
        rows: query.fetchRows(),
      };
    });

    const [rows, setRows] = useState<TResult[]>(initialState.rows);

    const refresh = useCallback(() => {
      setRows(query.fetchRows());
    }, [query]);

    const refetchRows = useEffectEvent(() => {
      if (rows !== initialState.rows || query !== initialState.query) {
        setRows(query.fetchRows());
      }
    });

    useEffect(() => {
      refetchRows();

      const { unsubscribe } = db.memoryDb.subsribeToQueryChanges({
        sql: query.sql,
        onDataChange: () => {
          setRows(query.fetchRows());
        },
      });

      return () => {
        unsubscribe();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [db, query]);

    return { rows, refresh };
  };

  return { useDb, DbProvider, useDbQuery };
}
