import type {
  ExecuteParams,
  SharedLiveQuery,
  SyncDbSchema,
  SyncedDb,
  TypedEvent,
  WorkerNotificationMessage,
  WorkerState,
} from "@sqlite-sync/core";
import { dummyKysely, parametersAreEqual } from "@sqlite-sync/core";
import type { Compilable, Kysely } from "kysely";
import { createContext, use, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

type DbQueryParams<Database, TResult> =
  | Compilable<TResult>
  | ((kysely: Kysely<Database>) => Compilable<TResult>)
  | ExecuteParams;

type UseDbQueryOptions<TResult, TMapResult = TResult> = {
  mapData?: (data: TResult[]) => TMapResult;
};

type DbEventMap = {
  [K in WorkerNotificationMessage["notificationType"]]: Extract<WorkerNotificationMessage, { notificationType: K }>;
};

type DbEventName = keyof DbEventMap & string;

type DbEventHandler<EventName extends DbEventName> = (event: TypedEvent<DbEventMap[EventName]>) => void;

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
      entry: SharedLiveQuery<TResult>;
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
        entry: db.db.getSharedLiveQuery<TResult>({ sql, parameters }),
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

  const useDbEvent = <EventName extends DbEventName>(eventName: EventName, handler: DbEventHandler<EventName>) => {
    const db = useDb();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
      const subscription = db.subscribe(eventName, (event) => {
        handlerRef.current(event as TypedEvent<DbEventMap[EventName]>);
      });

      return () => {
        subscription.unsubscribe();
      };
    }, [db, eventName]);
  };

  return { useDb, DbProvider, useDbQuery, useDbState, useDbEvent };
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
