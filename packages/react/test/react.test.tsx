import type { ExecuteParams, SyncedDb } from "@sqlite-sync/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbContext } from "../src/react";

const { DbProvider, useDbQuery, useDbEvent } = createDbContext({} as never);

type FakeLiveQuery = {
  query: ExecuteParams;
  unsubscribeCalls: number;
  getRows: ReturnType<typeof vi.fn<() => unknown[]>>;
  refresh: ReturnType<typeof vi.fn<() => void>>;
  subscribe: ReturnType<typeof vi.fn<(onchange: () => void) => () => void>>;
  setRows: (rows: unknown[]) => void;
};

afterEach(async () => {
  cleanup();
  await flushCleanupTimers();
});

describe("useDbQuery", () => {
  it("reuses one live query for identical sql and parameters", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={query} />
        <QueryView label="second" query={query} />
      </>,
    );

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(1);

    act(() => {
      fakeDb.liveQueries[0]?.setRows([{ value: "updated" }]);
    });

    expect(screen.getByTestId("first").textContent).toBe('[{"value":"updated"}]');
    expect(screen.getByTestId("second").textContent).toBe('[{"value":"updated"}]');
  });

  it("does not dedupe queries with different parameters", () => {
    const fakeDb = createFakeDb();
    const sql = "select * from todo where id = ?";

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={{ sql, parameters: [1] }} />
        <QueryView label="second" query={{ sql, parameters: [2] }} />
      </>,
    );

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe queries with different sql", () => {
    const fakeDb = createFakeDb();

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={{ sql: "select * from todo", parameters: [] }} />
        <QueryView label="second" query={{ sql: "select * from account", parameters: [] }} />
      </>,
    );

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(2);
  });

  it("releases the previous live query when parameters change", async () => {
    const fakeDb = createFakeDb();
    const { rerender } = renderWithDb(
      fakeDb.db,
      <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [1] }} />,
    );

    const firstLiveQuery = fakeDb.liveQueries[0];

    rerender(
      <DbProvider db={fakeDb.db}>
        <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [2] }} />
      </DbProvider>,
    );

    await waitFor(() => {
      expect(firstLiveQuery?.unsubscribeCalls).toBe(1);
    });
    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(2);
  });

  it("keeps mapData isolated per consumer while sharing the raw live query", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo", parameters: [] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="count" query={query} mapData={(rows) => rows.length} />
        <QueryView
          label="first-value"
          query={query}
          mapData={(rows) => (rows[0] as { value: string } | undefined)?.value ?? null}
        />
      </>,
    );

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(1);

    act(() => {
      fakeDb.liveQueries[0]?.setRows([{ value: "one" }, { value: "two" }]);
    });

    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(screen.getByTestId("first-value").textContent).toBe('"one"');
  });

  it("refreshes the active shared query for all consumers", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={query} />
        <QueryView label="second" query={query} />
      </>,
    );

    fireEvent.click(screen.getByTestId("refresh-first"));

    expect(fakeDb.liveQueries[0]?.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("first").textContent).toContain('"revision":1');
    expect(screen.getByTestId("second").textContent).toContain('"revision":1');
  });

  it("refreshes the current declarative query after parameters change", async () => {
    const fakeDb = createFakeDb();
    const { rerender } = renderWithDb(
      fakeDb.db,
      <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [1] }} />,
    );

    rerender(
      <DbProvider db={fakeDb.db}>
        <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [2] }} />
      </DbProvider>,
    );

    await waitFor(() => {
      expect(fakeDb.liveQueries[0]?.unsubscribeCalls).toBe(1);
    });

    fireEvent.click(screen.getByTestId("refresh-result"));

    expect(fakeDb.liveQueries[1]?.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result").textContent).toContain('"parameters":[2]');
    expect(screen.getByTestId("result").textContent).toContain('"revision":1');
  });

  it("does not create duplicate live queries when rendered inside StrictMode", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <StrictMode>
        <QueryView label="result" query={query} />
      </StrictMode>,
    );

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(1);

    act(() => {
      fakeDb.liveQueries[0]?.setRows([{ value: "strict-mode" }]);
    });

    expect(screen.getByTestId("result").textContent).toBe('[{"value":"strict-mode"}]');
  });

  it("cleans up the shared entry when the last subscriber unmounts", async () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;
    const { unmount } = renderWithDb(fakeDb.db, <QueryView label="result" query={query} />);

    const firstLiveQuery = fakeDb.liveQueries[0];

    unmount();
    await flushCleanupTimers();

    expect(firstLiveQuery?.unsubscribeCalls).toBe(1);

    renderWithDb(fakeDb.db, <QueryView label="result" query={query} />);

    expect(fakeDb.createLiveQuery).toHaveBeenCalledTimes(2);
  });
});

describe("useDbEvent", () => {
  it("subscribes to db events and unsubscribes on unmount", () => {
    const fakeDb = createFakeDb();
    const onEvent = vi.fn();

    const { unmount } = renderWithDb(fakeDb.db, <DbEventView eventName="de-sync-detected" onEvent={onEvent} />);

    expect(fakeDb.subscribe).toHaveBeenCalledTimes(1);
    expect(fakeDb.subscribe).toHaveBeenCalledWith("de-sync-detected", expect.any(Function));

    act(() => {
      fakeDb.emit("de-sync-detected", { notificationType: "de-sync-detected", reason: "CHECKSUM_MISMATCH" });
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].payload.reason).toBe("CHECKSUM_MISMATCH");

    unmount();

    expect(fakeDb.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("uses the latest handler without resubscribing", () => {
    const fakeDb = createFakeDb();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { rerender } = renderWithDb(
      fakeDb.db,
      <DbEventView eventName="remote-schema-version-mismatch" onEvent={firstHandler} />,
    );

    rerender(
      <DbProvider db={fakeDb.db}>
        <DbEventView eventName="remote-schema-version-mismatch" onEvent={secondHandler} />
      </DbProvider>,
    );

    expect(fakeDb.subscribe).toHaveBeenCalledTimes(1);

    act(() => {
      fakeDb.emit("remote-schema-version-mismatch", {
        notificationType: "remote-schema-version-mismatch",
        remoteSchemaVersion: 2,
        localSchemaVersion: 1,
      });
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler.mock.calls[0]?.[0].payload.remoteSchemaVersion).toBe(2);
  });
});

function QueryView({
  label,
  query,
  mapData,
}: {
  label: string;
  query: ExecuteParams;
  mapData?: (rows: unknown[]) => unknown;
}) {
  const { data, refresh } = useDbQuery(query, mapData ? { mapData } : undefined);

  return (
    <div>
      <button data-testid={`refresh-${label}`} onClick={() => refresh()} type="button">
        refresh
      </button>
      <output data-testid={label}>{JSON.stringify(data)}</output>
    </div>
  );
}

function DbEventView({
  eventName,
  onEvent,
}: {
  eventName: "de-sync-detected" | "remote-schema-version-mismatch";
  onEvent: (event: { payload: { reason?: string; remoteSchemaVersion?: number } }) => void;
}) {
  useDbEvent(eventName, onEvent);
  return null;
}

function renderWithDb(db: SyncedDb<unknown>, children: ReactNode) {
  return render(<DbProvider db={db}>{children}</DbProvider>);
}

function createFakeDb() {
  const liveQueries: FakeLiveQuery[] = [];
  const eventListeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const unsubscribe = vi.fn((eventName: string, listener: (event: { payload: unknown }) => void) => {
    eventListeners.get(eventName)?.delete(listener);
  });
  const subscribe = vi.fn((eventName: string, listener: (event: { payload: unknown }) => void) => {
    let listeners = eventListeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      eventListeners.set(eventName, listeners);
    }
    listeners.add(listener);
    return {
      unsubscribe: () => unsubscribe(eventName, listener),
    };
  });
  const createLiveQuery = vi.fn((query: ExecuteParams) => {
    const liveQuery = createFakeLiveQuery(query);
    liveQueries.push(liveQuery);
    return liveQuery;
  });

  const db = {
    db: {
      createLiveQuery,
    },
    state: {
      getState: () => ({ remoteState: "offline", deSynced: false, schemaVersionMismatched: false }),
      subscribe: () => () => {},
      goOnline: vi.fn(),
      goOffline: vi.fn(),
    },
    subscribe,
    dispose: vi.fn(),
    _internal: {
      executeAsync: vi.fn(),
    },
  } as unknown as SyncedDb<unknown>;

  const emit = (eventName: string, payload: unknown) => {
    for (const listener of eventListeners.get(eventName) ?? []) {
      listener({ payload });
    }
  };

  return { db, createLiveQuery, emit, liveQueries, subscribe, unsubscribe };
}

function createFakeLiveQuery(query: ExecuteParams): FakeLiveQuery {
  let subscriber: (() => void) | null = null;
  const currentParameters = query.parameters;
  let revision = 0;
  let rows = buildRows(query.sql, currentParameters, revision);

  const liveQuery: FakeLiveQuery = {
    query,
    unsubscribeCalls: 0,
    getRows: vi.fn(() => rows),
    refresh: vi.fn(() => {
      revision += 1;
      rows = buildRows(query.sql, currentParameters, revision);
      subscriber?.();
    }),
    subscribe: vi.fn((onchange: () => void) => {
      if (subscriber) {
        throw new Error("Subscriber already exists");
      }

      subscriber = onchange;

      return () => {
        liveQuery.unsubscribeCalls += 1;
        subscriber = null;
      };
    }),
    setRows: (nextRows) => {
      rows = nextRows;
      subscriber?.();
    },
  };

  return liveQuery;
}

function buildRows(sql: string, parameters: readonly unknown[], revision: number) {
  return [{ sql, parameters: [...parameters], revision }];
}

async function flushCleanupTimers() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
