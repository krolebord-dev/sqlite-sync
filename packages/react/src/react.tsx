import type { ExecuteParams, SyncDbSchema, SyncedDb, WorkerState } from "@sqlite-sync/core";
import { dummyKysely } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";
import { createContext, use, useMemo, useRef, useSyncExternalStore } from "react";

type DbQueryParams<Database, TResult> =
  | Compilable<TResult>
  | ((kysely: Kysely<Database>) => Compilable<TResult>)
  | ExecuteParams;

type UseDbQueryOptions<TResult, TMapResult = TResult> = {
  mapData?: (data: TResult[]) => TMapResult;
};

type LiveQuery<TResult> = {
  getRows: () => TResult[];
  refresh: () => void;
  subscribe: (onchange: () => void) => () => void;
};

type SharedLiveQueryEntry = {
  sql: string;
  parameters: readonly unknown[];
  liveQuery: LiveQuery<unknown>;
  listeners: Set<() => void>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
  unsubscribeFromLiveQuery: (() => void) | null;
  getRows: () => unknown[];
  refresh: () => void;
  subscribe: (onchange: () => void) => () => void;
};

const sharedLiveQueries = new WeakMap<object, Map<string, SharedLiveQueryEntry[]>>();

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

    const sharedQueryRef = useRef<{
      db: unknown;
      sql: string;
      parameters: readonly unknown[];
      entry: SharedLiveQueryEntry;
    } | null>(null);
    if (
      !sharedQueryRef.current ||
      sharedQueryRef.current.db !== db ||
      sharedQueryRef.current.sql !== sql ||
      !parametersAreEqual(sharedQueryRef.current.parameters, parameters)
    ) {
      sharedQueryRef.current = {
        db,
        sql,
        parameters,
        entry: getSharedLiveQuery(db, { sql, parameters }),
      };
    }

    const sharedQuery = sharedQueryRef.current.entry;

    const data = useSyncExternalStore(sharedQuery.subscribe, sharedQuery.getRows) as TResult[];

    const mapDataRef = useRef(mapData);
    mapDataRef.current = mapData;

    const mappedData = useMemo(() => {
      return mapDataRef.current ? mapDataRef.current(data) : data;
    }, [data]) as TMapResult;

    return { data: mappedData, refresh: sharedQuery.refresh };
  };

  const useDbState = (): WorkerState => {
    const db = useDb();

    return useSyncExternalStore<WorkerState>(db.state.subscribe, db.state.getState);
  };

  return { useDb, DbProvider, useDbQuery, useDbState };
}

function getSharedLiveQuery<Database, TResult>(
  db: SyncedDb<Database>,
  query: ExecuteParams,
): SharedLiveQueryEntry & {
  getRows: () => TResult[];
} {
  const queryCache = getOrCreateQueryCache(db);
  const existingEntry = queryCache
    .get(query.sql)
    ?.find((entry) => parametersAreEqual(entry.parameters, query.parameters));
  if (existingEntry) {
    cancelEntryCleanup(existingEntry);
    return existingEntry as SharedLiveQueryEntry & { getRows: () => TResult[] };
  }

  const liveQuery = db.db.createLiveQuery<TResult>(query);
  const entry: SharedLiveQueryEntry = {
    sql: query.sql,
    parameters: query.parameters,
    liveQuery: liveQuery as LiveQuery<unknown>,
    listeners: new Set(),
    cleanupTimeout: null,
    unsubscribeFromLiveQuery: null,
    getRows: () => liveQuery.getRows(),
    refresh: () => {
      liveQuery.refresh();
    },
    subscribe: (onchange) => {
      cancelEntryCleanup(entry);
      entry.listeners.add(onchange);

      if (!entry.unsubscribeFromLiveQuery) {
        entry.unsubscribeFromLiveQuery = liveQuery.subscribe(() => {
          for (const listener of entry.listeners) {
            listener();
          }
        });
      }

      return () => {
        entry.listeners.delete(onchange);

        if (entry.listeners.size === 0) {
          entry.unsubscribeFromLiveQuery?.();
          entry.unsubscribeFromLiveQuery = null;
          scheduleEntryCleanup(db, entry);
        }
      };
    },
  };

  const matchingSqlEntries = queryCache.get(query.sql) ?? [];
  matchingSqlEntries.push(entry);
  queryCache.set(query.sql, matchingSqlEntries);
  scheduleEntryCleanup(db, entry);

  return entry as SharedLiveQueryEntry & { getRows: () => TResult[] };
}

function getOrCreateQueryCache(db: object) {
  let queryCache = sharedLiveQueries.get(db);
  if (!queryCache) {
    queryCache = new Map<string, SharedLiveQueryEntry[]>();
    sharedLiveQueries.set(db, queryCache);
  }
  return queryCache;
}

function scheduleEntryCleanup(db: object, entry: SharedLiveQueryEntry) {
  cancelEntryCleanup(entry);
  entry.cleanupTimeout = setTimeout(() => {
    entry.cleanupTimeout = null;

    if (entry.listeners.size > 0 || entry.unsubscribeFromLiveQuery) {
      return;
    }

    const queryCache = sharedLiveQueries.get(db);
    const matchingSqlEntries = queryCache?.get(entry.sql);
    if (!matchingSqlEntries) {
      return;
    }

    const nextEntries = matchingSqlEntries.filter((candidate) => candidate !== entry);
    if (nextEntries.length > 0) {
      queryCache?.set(entry.sql, nextEntries);
    } else {
      queryCache?.delete(entry.sql);
    }

    if (queryCache?.size === 0) {
      sharedLiveQueries.delete(db);
    }
  }, 0);
}

function cancelEntryCleanup(entry: SharedLiveQueryEntry) {
  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
    entry.cleanupTimeout = null;
  }
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
