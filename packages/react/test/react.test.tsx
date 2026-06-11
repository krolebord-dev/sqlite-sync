import type { ExecuteParams, SharedLiveQuery, SyncedDb } from "@sqlite-sync/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbContext } from "../src/react";

const { DbProvider, useDbQuery, useDbEvent } = createDbContext({} as never);

// Thin stand-in for core's getSharedLiveQuery: returns a stable entry per
// sql+parameters and tracks subscribers. Sharing/eviction semantics are core's
// contract, covered by packages/core/test/shared-live-query.test.ts — these
// tests only verify how useDbQuery consumes that contract.
type FakeSharedQuery = SharedLiveQuery<unknown> & {
  refresh: ReturnType<typeof vi.fn<() => void>>;
  setRows: (rows: unknown[]) => void;
};

afterEach(() => {
  cleanup();
});

describe("useDbQuery", () => {
  it("renders the shared query rows and re-renders when the query notifies", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(fakeDb.db, <QueryView label="result" query={query} />);

    const entry = fakeDb.entries[0];
    expect(entry?.getSubscriberCount()).toBe(1);

    act(() => {
      entry?.setRows([{ value: "updated" }]);
    });

    expect(screen.getByTestId("result").textContent).toBe('[{"value":"updated"}]');
  });

  it("requests the shared query once per query identity across re-renders", () => {
    const fakeDb = createFakeDb();

    const { rerender } = renderWithDb(
      fakeDb.db,
      <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [1] }} />,
    );

    rerender(
      <DbProvider db={fakeDb.db}>
        <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [1] }} />
      </DbProvider>,
    );

    expect(fakeDb.getSharedLiveQuery).toHaveBeenCalledTimes(1);
  });

  it("shares one entry between consumers of the same query and updates both", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={query} />
        <QueryView label="second" query={query} />
      </>,
    );

    expect(fakeDb.entries).toHaveLength(1);
    expect(fakeDb.entries[0]?.getSubscriberCount()).toBe(2);

    act(() => {
      fakeDb.entries[0]?.setRows([{ value: "updated" }]);
    });

    expect(screen.getByTestId("first").textContent).toBe('[{"value":"updated"}]');
    expect(screen.getByTestId("second").textContent).toBe('[{"value":"updated"}]');
  });

  it("uses distinct entries for different parameters or sql", () => {
    const fakeDb = createFakeDb();
    const sql = "select * from todo where id = ?";

    renderWithDb(
      fakeDb.db,
      <>
        <QueryView label="first" query={{ sql, parameters: [1] }} />
        <QueryView label="second" query={{ sql, parameters: [2] }} />
        <QueryView label="third" query={{ sql: "select * from account", parameters: [] }} />
      </>,
    );

    expect(fakeDb.entries).toHaveLength(3);
  });

  it("switches to a new entry and unsubscribes from the previous one when parameters change", async () => {
    const fakeDb = createFakeDb();
    const { rerender } = renderWithDb(
      fakeDb.db,
      <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [1] }} />,
    );

    const firstEntry = fakeDb.entries[0];

    rerender(
      <DbProvider db={fakeDb.db}>
        <QueryView label="result" query={{ sql: "select * from todo where id = ?", parameters: [2] }} />
      </DbProvider>,
    );

    await waitFor(() => {
      expect(firstEntry?.getSubscriberCount()).toBe(0);
    });
    expect(fakeDb.entries).toHaveLength(2);
    expect(fakeDb.entries[1]?.getSubscriberCount()).toBe(1);
    expect(screen.getByTestId("result").textContent).toContain('"parameters":[2]');
  });

  it("keeps mapData isolated per consumer while sharing the entry", () => {
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

    expect(fakeDb.entries).toHaveLength(1);

    act(() => {
      fakeDb.entries[0]?.setRows([{ value: "one" }, { value: "two" }]);
    });

    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(screen.getByTestId("first-value").textContent).toBe('"one"');
  });

  it("delegates refresh to the shared entry and updates all consumers", () => {
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

    expect(fakeDb.entries[0]?.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("first").textContent).toContain('"revision":1');
    expect(screen.getByTestId("second").textContent).toContain('"revision":1');
  });

  it("refreshes the current entry after parameters change", async () => {
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
      expect(fakeDb.entries[0]?.getSubscriberCount()).toBe(0);
    });

    fireEvent.click(screen.getByTestId("refresh-result"));

    expect(fakeDb.entries[0]?.refresh).not.toHaveBeenCalled();
    expect(fakeDb.entries[1]?.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result").textContent).toContain('"parameters":[2]');
    expect(screen.getByTestId("result").textContent).toContain('"revision":1');
  });

  it("ends up with a single subscription per consumer under StrictMode", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;

    renderWithDb(
      fakeDb.db,
      <StrictMode>
        <QueryView label="result" query={query} />
      </StrictMode>,
    );

    expect(fakeDb.entries).toHaveLength(1);
    expect(fakeDb.entries[0]?.getSubscriberCount()).toBe(1);

    act(() => {
      fakeDb.entries[0]?.setRows([{ value: "strict-mode" }]);
    });

    expect(screen.getByTestId("result").textContent).toBe('[{"value":"strict-mode"}]');
  });

  it("unsubscribes from the entry on unmount", () => {
    const fakeDb = createFakeDb();
    const query = { sql: "select * from todo where id = ?", parameters: [1] } satisfies ExecuteParams;
    const { unmount } = renderWithDb(fakeDb.db, <QueryView label="result" query={query} />);

    expect(fakeDb.entries[0]?.getSubscriberCount()).toBe(1);

    unmount();

    expect(fakeDb.entries[0]?.getSubscriberCount()).toBe(0);
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
  const entries: FakeSharedQuery[] = [];
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
  const getSharedLiveQuery = vi.fn((query: ExecuteParams): SharedLiveQuery<unknown> => {
    const existing = entries.find(
      (entry) => entry.sql === query.sql && JSON.stringify(entry.parameters) === JSON.stringify(query.parameters),
    );
    if (existing) {
      return existing;
    }

    const listeners = new Set<() => void>();
    let revision = 0;
    let rows: unknown[] = buildRows(query.sql, query.parameters, revision);
    const notify = () => {
      for (const listener of listeners) {
        listener();
      }
    };

    const entry: FakeSharedQuery = {
      sql: query.sql,
      parameters: query.parameters,
      getRows: () => rows,
      refresh: vi.fn(() => {
        revision += 1;
        rows = buildRows(query.sql, query.parameters, revision);
        notify();
      }),
      getSubscriberCount: () => listeners.size,
      subscribe: (onchange) => {
        listeners.add(onchange);
        return () => {
          listeners.delete(onchange);
        };
      },
      setRows: (nextRows) => {
        rows = nextRows;
        notify();
      },
    };

    entries.push(entry);
    return entry;
  });

  const db = {
    db: {
      getSharedLiveQuery,
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

  return { db, emit, entries, getSharedLiveQuery, subscribe, unsubscribe };
}

function buildRows(sql: string, parameters: readonly unknown[], revision: number) {
  return [{ sql, parameters: [...parameters], revision }];
}
