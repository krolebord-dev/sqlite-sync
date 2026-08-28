import type { ColumnMeta, SharedLiveQuerySnapshot, SyncedDbExport } from "@sqlite-sync/core";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  getOrCreateSQLiteSyncDevtoolsRegistry,
  type SQLiteSyncDevtoolsInstance,
  type SQLiteSyncDevtoolsSnapshot,
} from "./devtools-registry";
import { ShadowRoot } from "./shadow-root";

export type SQLiteSyncDevtoolsProps = {
  className?: string;
  /** Hide the floating launcher. Omit to let the user toggle it with Ctrl+Alt+S (⌘⌥S on macOS). */
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
};

type DevtoolsTab = "overview" | "schema" | "live-queries" | "event-log" | "query-runner";
type QueryTarget = "memory" | "worker";

type QueryState =
  | {
      status: "idle";
    }
  | {
      status: "running";
    }
  | {
      status: "success";
      output: {
        target: QueryTarget;
        sql: string;
        rowCount: number;
        durationMs: number;
        rows: unknown[];
      };
    }
  | {
      status: "error";
      error: {
        target: QueryTarget;
        sql: string;
        message: string;
      };
    };

const TRIGGER_POSITION_STORAGE_KEY = "sqlite-sync-devtools.trigger-position";
const TRIGGER_HIDDEN_STORAGE_KEY = "sqlite-sync-devtools.trigger-hidden";
const DRAG_THRESHOLD_PX = 4;
const VIEWPORT_MARGIN_PX = 8;
const IS_APPLE_PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const TOGGLE_LAUNCHER_HINT = IS_APPLE_PLATFORM ? "⌘⌥S" : "Ctrl+Alt+S";

type TriggerPosition = { x: number; y: number };

function readStoredTriggerPosition(): TriggerPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TRIGGER_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TriggerPosition>;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {}
  return null;
}

function useDraggableTrigger() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<TriggerPosition | null>(readStoredTriggerPosition);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  // pointerup clears dragRef before the click event fires, so the moved flag is
  // stashed here to suppress the click that a drag gesture would otherwise emit.
  const suppressClickRef = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const button = buttonRef.current;
    if (!button || event.button !== 0) return;
    suppressClickRef.current = false;
    const rect = button.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    button.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const button = buttonRef.current;
    if (!drag || !button || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    const maxX = window.innerWidth - button.offsetWidth - VIEWPORT_MARGIN_PX;
    const maxY = window.innerHeight - button.offsetHeight - VIEWPORT_MARGIN_PX;
    setPosition({
      x: Math.max(VIEWPORT_MARGIN_PX, Math.min(event.clientX - drag.offsetX, maxX)),
      y: Math.max(VIEWPORT_MARGIN_PX, Math.min(event.clientY - drag.offsetY, maxY)),
    });
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    buttonRef.current?.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    suppressClickRef.current = true;
    setPosition((current) => {
      if (current && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(TRIGGER_POSITION_STORAGE_KEY, JSON.stringify(current));
        } catch {}
      }
      return current;
    });
  }, []);

  const consumeDragClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const positionStyle: CSSProperties = position
    ? { left: position.x, top: position.y, right: "auto", bottom: "auto" }
    : {};

  return {
    buttonRef,
    positionStyle,
    triggerHandlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
    consumeDragClick,
  };
}

function readStoredTriggerHidden(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TRIGGER_HIDDEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isToggleLauncherShortcut(event: KeyboardEvent): boolean {
  // Option/Alt remaps event.key (Option+S is "ß" on US Mac), so match the physical key.
  if (event.shiftKey || !event.altKey || event.code !== "KeyS") return false;
  return event.ctrlKey || event.metaKey;
}

function useLauncherVisibility({
  hidden: hiddenProp,
  onHiddenChange,
}: Pick<SQLiteSyncDevtoolsProps, "hidden" | "onHiddenChange">) {
  const isControlled = hiddenProp !== undefined;
  const [uncontrolledHidden, setUncontrolledHidden] = useState(readStoredTriggerHidden);
  const hidden = isControlled ? hiddenProp : uncontrolledHidden;
  const canToggle = !isControlled || onHiddenChange !== undefined;

  const setHidden = useCallback(
    (next: boolean) => {
      if (isControlled) {
        onHiddenChange?.(next);
        return;
      }
      setUncontrolledHidden(next);
      try {
        window.localStorage.setItem(TRIGGER_HIDDEN_STORAGE_KEY, next ? "1" : "0");
      } catch {}
    },
    [isControlled, onHiddenChange],
  );

  useEffect(() => {
    if (!canToggle) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isToggleLauncherShortcut(event)) return;
      event.preventDefault();
      setHidden(!hidden);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canToggle, hidden, setHidden]);

  return { hidden, setHidden, canToggle };
}

export function SQLiteSyncDevtools({ className, hidden: hiddenProp, onHiddenChange }: SQLiteSyncDevtoolsProps) {
  const registry = getOrCreateSQLiteSyncDevtoolsRegistry();
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, getEmptySnapshot);
  const instances = snapshot.instances;

  const { buttonRef, positionStyle, triggerHandlers, consumeDragClick } = useDraggableTrigger();
  const { hidden, setHidden, canToggle } = useLauncherVisibility({ hidden: hiddenProp, onHiddenChange });

  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DevtoolsTab>("overview");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [queryTarget, setQueryTarget] = useState<QueryTarget>("memory");
  const [query, setQuery] = useState("");
  const [queryState, setQueryState] = useState<QueryState>({
    status: "idle",
  });

  useEffect(() => {
    if (hidden) setIsOpen(false);
  }, [hidden]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (instances.length === 0) {
      setSelectedInstanceId("");
      return;
    }

    if (instances.some((instance) => instance.instanceId === selectedInstanceId)) {
      return;
    }

    setSelectedInstanceId(instances[0]?.instanceId ?? "");
  }, [instances, selectedInstanceId]);

  const dbIdCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const instance of instances) {
      counts.set(instance.dbId, (counts.get(instance.dbId) ?? 0) + 1);
    }

    return counts;
  }, [instances]);

  const selectedInstance = useMemo(() => {
    return instances.find((instance) => instance.instanceId === selectedInstanceId) ?? null;
  }, [instances, selectedInstanceId]);

  const canRunQuery = selectedInstance !== null && query.trim().length > 0 && queryState.status !== "running";

  const runQuery = async () => {
    if (!selectedInstance) return;

    let normalizedQuery = query.trim();

    try {
      normalizedQuery = normalizeSingleStatement(query);
      const statementKind = getStatementKind(normalizedQuery);

      if (queryTarget === "worker") {
        if (!isWorkerReadOnlyStatement(statementKind)) {
          throw new Error("Worker DB devtools only allows read-only SQL: SELECT, PRAGMA.");
        }
      } else {
        const touchedTables = selectedInstance.instance._internal.getMemoryQueryTables(normalizedQuery);
        const writtenTables = touchedTables.filter((table) => table.isWrite).map((table) => table.name);
        const allowedTables = new Set(selectedInstance.instance._internal.crdtTableNames);

        const invalidTables = writtenTables.filter((table) => !allowedTables.has(table));
        if (invalidTables.length > 0) {
          throw new Error(
            `Memory DB writes are only allowed for CRDT tables. Rejected tables: ${invalidTables.join(", ")}`,
          );
        }
      }

      setQueryState({ status: "running" });
      const startedAt = performance.now();

      const result =
        queryTarget === "memory"
          ? selectedInstance.instance.db.execute(normalizedQuery)
          : await selectedInstance.instance._internal.executeAsync({
              sql: normalizedQuery,
              parameters: [],
            });

      setQueryState({
        status: "success",
        output: {
          target: queryTarget,
          sql: normalizedQuery,
          rowCount: result.rows.length,
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
          rows: result.rows,
        },
      });
    } catch (error) {
      setQueryState({
        status: "error",
        error: {
          target: queryTarget,
          sql: normalizedQuery,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  return (
    <ShadowRoot className={className}>
      {hidden ? null : (
        <div className="floatingRoot">
          <button
            ref={buttonRef}
            type="button"
            className="triggerButton"
            style={positionStyle}
            onClick={() => {
              if (consumeDragClick()) return;
              setIsOpen(true);
            }}
            title={`SQLite Sync Devtools (${TOGGLE_LAUNCHER_HINT} to hide)`}
            {...triggerHandlers}
          >
            <span className="triggerIcon">◈</span>
            <span className="triggerCount">{instances.length}</span>
          </button>
        </div>
      )}

      {isOpen ? (
        <div className="overlay" onClick={() => setIsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label="SQLite Sync devtools"
            className="dialog"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Dialog header */}
            <div className="header">
              <div className="headerLeft">
                <span className="headerLogo">◈</span>
                <div>
                  <div className="eyebrow">sqlite-sync</div>
                  <h2 className="title">Devtools</h2>
                </div>
              </div>

              <div className="headerRight">
                {instances.length > 0 && (
                  <label className="instancePickerLabel">
                    <span className="instancePickerText">DB</span>
                    <select
                      value={selectedInstanceId}
                      onChange={(event) => setSelectedInstanceId(event.target.value)}
                      className="instancePickerSelect"
                    >
                      {instances.map((instance) => (
                        <option key={instance.instanceId} value={instance.instanceId}>
                          {formatInstanceLabel(instance.dbId, instance.instanceId, dbIdCounts.get(instance.dbId) ?? 0)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span className="instanceCountBadge">
                  {instances.length} instance{instances.length !== 1 ? "s" : ""}
                </span>
                {canToggle && (
                  <button
                    type="button"
                    className="hideLauncherButton"
                    onClick={() => setHidden(true)}
                    title={`Hide launcher (${TOGGLE_LAUNCHER_HINT} to show again)`}
                  >
                    Hide
                  </button>
                )}
                <button type="button" className="closeButton" onClick={() => setIsOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
            </div>

            {instances.length === 0 ? (
              <div className="emptyState">
                <div className="emptyStateIcon">◈</div>
                <p className="emptyStateText">No SQLite Sync database instances registered.</p>
                <p className="emptyStateSubtext">
                  Call <code className="inlineCode">registerDevtools(db)</code> in your app to get started.
                </p>
              </div>
            ) : (
              <div className="contentLayout">
                {/* Sidebar nav */}
                <aside className="sidebar">
                  <nav className="nav">
                    <button
                      type="button"
                      className="tabButton"
                      data-active={activeTab === "overview" ? "true" : undefined}
                      onClick={() => setActiveTab("overview")}
                    >
                      <span className="navIcon">▦</span>
                      Overview
                    </button>
                    <button
                      type="button"
                      className="tabButton"
                      data-active={activeTab === "schema" ? "true" : undefined}
                      onClick={() => setActiveTab("schema")}
                    >
                      <span className="navIcon">⬡</span>
                      Schema
                    </button>
                    <button
                      type="button"
                      className="tabButton"
                      data-active={activeTab === "live-queries" ? "true" : undefined}
                      onClick={() => setActiveTab("live-queries")}
                    >
                      <span className="navIcon">◉</span>
                      Live Queries
                    </button>
                    <button
                      type="button"
                      className="tabButton"
                      data-active={activeTab === "event-log" ? "true" : undefined}
                      onClick={() => setActiveTab("event-log")}
                    >
                      <span className="navIcon">≡</span>
                      Event Log
                    </button>
                    <button
                      type="button"
                      className="tabButton"
                      data-active={activeTab === "query-runner" ? "true" : undefined}
                      onClick={() => setActiveTab("query-runner")}
                    >
                      <span className="navIcon">▶</span>
                      Query Runner
                    </button>
                  </nav>

                  {selectedInstance && (
                    <div className="sidebarInfo">
                      <div className="sidebarInfoLabel">Active instance</div>
                      <div className="sidebarInfoValue">
                        {formatInstanceLabel(
                          selectedInstance.dbId,
                          selectedInstance.instanceId,
                          dbIdCounts.get(selectedInstance.dbId) ?? 0,
                        )}
                      </div>
                      <div className="sidebarInfoSub">id: {selectedInstance.instanceId.slice(0, 12)}…</div>
                    </div>
                  )}
                </aside>

                {/* Main pane */}
                <div className="mainPane">
                  {activeTab === "overview" ? (
                    <OverviewTab selectedInstance={selectedInstance} dbIdCounts={dbIdCounts} />
                  ) : activeTab === "schema" ? (
                    <SchemaTab selectedInstance={selectedInstance} />
                  ) : activeTab === "live-queries" ? (
                    <LiveQueriesTab selectedInstance={selectedInstance} />
                  ) : activeTab === "event-log" ? (
                    <EventLogTab selectedInstance={selectedInstance} />
                  ) : (
                    <QueryRunnerTab
                      selectedInstance={selectedInstance}
                      queryTarget={queryTarget}
                      setQueryTarget={setQueryTarget}
                      query={query}
                      setQuery={setQuery}
                      queryState={queryState}
                      canRunQuery={canRunQuery}
                      runQuery={runQuery}
                    />
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </ShadowRoot>
  );
}

const EVENT_HLC_ACCUMULATOR_KV_KEY = "crdt.consistency.event_hlc_sum.v2";
const EVENT_HLC_ACCUMULATOR_QUERY = `SELECT value FROM "worker"."kv" WHERE key = '${EVENT_HLC_ACCUMULATOR_KV_KEY}'`;
const EVENT_STATUS_COUNTS_QUERY = `SELECT status, COUNT(*) AS count FROM "worker"."crdt_events" GROUP BY status`;
const MEMORY_DB_SIZE_QUERY =
  "SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes";
// Persisted main file plus the attached worker schema (event log, kv).
const WORKER_DB_SIZE_QUERY = `SELECT
  (SELECT page_count FROM pragma_page_count('main')) * (SELECT page_size FROM pragma_page_size('main'))
  + (SELECT page_count FROM pragma_page_count('worker')) * (SELECT page_size FROM pragma_page_size('worker'))
  AS bytes`;

type EventStatus = "pending" | "applied" | "failed" | "deduped";
type EventStatusCounts = { total: number } & Record<EventStatus, number>;

const EVENT_STATUS_META: Record<EventStatus, { label: string; tone: "amber" | "success" | "error" | "muted" }> = {
  pending: { label: "Pending", tone: "amber" },
  applied: { label: "Applied", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  deduped: { label: "Deduped", tone: "muted" },
};

function isEventStatus(value: unknown): value is EventStatus {
  return value === "pending" || value === "applied" || value === "failed" || value === "deduped";
}

function emptyEventStatusCounts(): EventStatusCounts {
  return { total: 0, pending: 0, applied: 0, failed: 0, deduped: 0 };
}

function parseEventStatusCounts(rows: readonly unknown[]): EventStatusCounts {
  const counts = emptyEventStatusCounts();

  for (const row of rows) {
    if (typeof row !== "object" || row === null || !("status" in row) || !("count" in row)) {
      continue;
    }
    const { status, count } = row;
    if (!isEventStatus(status)) continue;
    const n = typeof count === "number" ? count : Number(count);
    if (!Number.isFinite(n)) continue;
    counts[status] = n;
    counts.total += n;
  }

  return counts;
}

function readCount(rows: readonly unknown[]): number {
  const row = rows[0];
  if (typeof row !== "object" || row === null || !("count" in row)) return 0;
  const n = typeof row.count === "number" ? row.count : Number(row.count);
  return Number.isFinite(n) ? n : 0;
}

function readBytes(rows: readonly unknown[]): number | null {
  const row = rows[0];
  if (typeof row !== "object" || row === null || !("bytes" in row)) return null;
  const n = typeof row.bytes === "number" ? row.bytes : Number(row.bytes);
  return Number.isFinite(n) ? n : null;
}

function formatByteSize(bytes: number): { label: string; exact: string } {
  const exact = `${bytes.toLocaleString("en-US")} B`;
  if (bytes < 1024) return { label: exact, exact };

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return { label: `${Number(value.toFixed(decimals))} ${units[unitIndex]}`, exact };
}

function OverviewTab({
  selectedInstance,
  dbIdCounts,
}: {
  selectedInstance: SQLiteSyncDevtoolsInstance | null;
  dbIdCounts: Map<string, number>;
}) {
  const [eventHlcAccumulator, setEventHlcAccumulator] = useState<string | null>(null);
  const [accumulatorError, setAccumulatorError] = useState<string | null>(null);
  const [isAccumulatorLoading, setIsAccumulatorLoading] = useState(false);
  const [eventCounts, setEventCounts] = useState<EventStatusCounts | null>(null);
  const [eventCountsError, setEventCountsError] = useState<string | null>(null);
  const [isEventCountsLoading, setIsEventCountsLoading] = useState(false);
  const [memoryBytes, setMemoryBytes] = useState<number | null>(null);
  const [memorySizeError, setMemorySizeError] = useState<string | null>(null);
  const [workerBytes, setWorkerBytes] = useState<number | null>(null);
  const [workerSizeError, setWorkerSizeError] = useState<string | null>(null);
  const [isSizeLoading, setIsSizeLoading] = useState(false);

  const refreshEventHlcAccumulator = useCallback(async () => {
    if (!selectedInstance) return;
    setIsAccumulatorLoading(true);
    setAccumulatorError(null);
    try {
      const result = await selectedInstance.instance._internal.executeAsync({
        sql: EVENT_HLC_ACCUMULATOR_QUERY,
        parameters: [],
      });
      const row = result.rows[0];
      const value =
        typeof row === "object" && row !== null && "value" in row && typeof row.value === "string" ? row.value : "";
      setEventHlcAccumulator(value);
    } catch (error) {
      setAccumulatorError(error instanceof Error ? error.message : String(error));
      setEventHlcAccumulator(null);
    } finally {
      setIsAccumulatorLoading(false);
    }
  }, [selectedInstance]);

  const refreshEventCounts = useCallback(async () => {
    if (!selectedInstance) return;
    setIsEventCountsLoading(true);
    setEventCountsError(null);
    try {
      const result = await selectedInstance.instance._internal.executeAsync({
        sql: EVENT_STATUS_COUNTS_QUERY,
        parameters: [],
      });
      setEventCounts(parseEventStatusCounts(result.rows));
    } catch (error) {
      setEventCountsError(error instanceof Error ? error.message : String(error));
      setEventCounts(null);
    } finally {
      setIsEventCountsLoading(false);
    }
  }, [selectedInstance]);

  const refreshDbSizes = useCallback(async () => {
    if (!selectedInstance) return;
    setIsSizeLoading(true);
    setMemorySizeError(null);
    setWorkerSizeError(null);

    const memoryResult = Promise.resolve()
      .then(() => selectedInstance.instance.db.execute(MEMORY_DB_SIZE_QUERY))
      .then((result) => {
        const bytes = readBytes(result.rows);
        if (bytes === null) throw new Error("Memory DB did not return a size.");
        return bytes;
      });
    const workerResult = selectedInstance.instance._internal
      .executeAsync({ sql: WORKER_DB_SIZE_QUERY, parameters: [] })
      .then((result) => {
        const bytes = readBytes(result.rows);
        if (bytes === null) throw new Error("Worker DB did not return a size.");
        return bytes;
      });

    const [memorySettled, workerSettled] = await Promise.allSettled([memoryResult, workerResult]);
    if (memorySettled.status === "fulfilled") {
      setMemoryBytes(memorySettled.value);
    } else {
      setMemoryBytes(null);
      setMemorySizeError(
        memorySettled.reason instanceof Error ? memorySettled.reason.message : String(memorySettled.reason),
      );
    }
    if (workerSettled.status === "fulfilled") {
      setWorkerBytes(workerSettled.value);
    } else {
      setWorkerBytes(null);
      setWorkerSizeError(
        workerSettled.reason instanceof Error ? workerSettled.reason.message : String(workerSettled.reason),
      );
    }
    setIsSizeLoading(false);
  }, [selectedInstance]);

  useEffect(() => {
    setEventHlcAccumulator(null);
    setAccumulatorError(null);
    setEventCounts(null);
    setEventCountsError(null);
    setMemoryBytes(null);
    setMemorySizeError(null);
    setWorkerBytes(null);
    setWorkerSizeError(null);
    void refreshEventHlcAccumulator();
    void refreshEventCounts();
    void refreshDbSizes();
  }, [refreshEventHlcAccumulator, refreshEventCounts, refreshDbSizes]);

  if (!selectedInstance) return null;

  const label = formatInstanceLabel(
    selectedInstance.dbId,
    selectedInstance.instanceId,
    dbIdCounts.get(selectedInstance.dbId) ?? 0,
  );

  return (
    <div className="overviewLayout">
      <div className="overviewCardsRow">
        <div className="overviewCard">
          <div className="overviewCardLabel">Database</div>
          <div className="overviewCardValue">{label}</div>
        </div>
        <div className="overviewCard">
          <div className="overviewCardLabel">Instance ID</div>
          <div className="overviewCardValue mono sm">{selectedInstance.instanceId.slice(0, 16)}…</div>
        </div>
        <DbSizeCard label="Memory DB" bytes={memoryBytes} error={memorySizeError} loading={isSizeLoading} />
        <DbSizeCard label="Worker DB" bytes={workerBytes} error={workerSizeError} loading={isSizeLoading} />
        <div className="overviewCard">
          <div className="overviewCardLabel">CRDT Events</div>
          <div className="overviewCardValue">
            {eventCountsError ? "—" : isEventCountsLoading && eventCounts === null ? "…" : (eventCounts?.total ?? 0)}
          </div>
        </div>
      </div>

      <div className="overviewSection">
        <div className="overviewSectionHeader">
          <div className="overviewSectionTitle">CRDT events</div>
          <button
            type="button"
            className="refreshButton"
            disabled={isEventCountsLoading || isSizeLoading}
            title="Refresh event counts and DB sizes"
            onClick={() => {
              void refreshEventCounts();
              void refreshDbSizes();
            }}
          >
            {isEventCountsLoading || isSizeLoading ? "…" : "↻"} Refresh
          </button>
        </div>
        {eventCountsError ? (
          <div className="overviewAccumulatorError">{eventCountsError}</div>
        ) : (
          <div className="eventCountGrid">
            {(["pending", "applied", "failed", "deduped"] satisfies EventStatus[]).map((status) => {
              const item = EVENT_STATUS_META[status];
              const value = eventCounts?.[status] ?? 0;
              return (
                <div key={status} className="eventCountCard">
                  <div
                    className="eventCountValue"
                    data-tone={item.tone}
                    data-emphasize={value > 0 ? "true" : undefined}
                  >
                    {isEventCountsLoading && eventCounts === null ? "…" : value}
                  </div>
                  <div className="overviewCardLabel">{item.label}</div>
                </div>
              );
            })}
          </div>
        )}
        <div className="overviewEmpty">Counts are remaining worker log rows after GC, not lifetime history.</div>
      </div>

      <div className="overviewSection">
        <div className="overviewSectionHeader">
          <div className="overviewSectionTitle">Event HLC accumulator</div>
          <button
            type="button"
            className="refreshButton"
            disabled={isAccumulatorLoading}
            onClick={() => void refreshEventHlcAccumulator()}
          >
            {isAccumulatorLoading ? "…" : "↻"} Refresh
          </button>
        </div>
        <div className="overviewAccumulatorValue">
          {accumulatorError ? (
            <span className="overviewAccumulatorError">{accumulatorError}</span>
          ) : isAccumulatorLoading && eventHlcAccumulator === null ? (
            "Loading…"
          ) : eventHlcAccumulator === "" ? (
            <span className="overviewAccumulatorEmpty">(empty)</span>
          ) : (
            eventHlcAccumulator
          )}
        </div>
      </div>

      <DataSection
        key={selectedInstance.instanceId}
        dbId={selectedInstance.dbId}
        instance={selectedInstance.instance}
      />

      <ResetSection dbId={selectedInstance.dbId} instance={selectedInstance.instance} />
    </div>
  );
}

function DbSizeCard({
  label,
  bytes,
  error,
  loading,
}: {
  label: string;
  bytes: number | null;
  error: string | null;
  loading: boolean;
}) {
  let value = "…";
  let sub: string | undefined;
  let title: string | undefined;

  if (error) {
    value = "—";
    title = error;
  } else if (bytes !== null) {
    const formatted = formatByteSize(bytes);
    value = formatted.label;
    title = formatted.exact;
    sub = formatted.label === formatted.exact ? undefined : formatted.exact;
  } else if (!loading) {
    value = "—";
  }

  return (
    <div className="overviewCard" title={title}>
      <div className="overviewCardLabel">{label}</div>
      <div className="overviewCardValue mono">{value}</div>
      {sub ? <div className="overviewCardSub">{sub}</div> : null}
    </div>
  );
}

function DataSection({ dbId, instance }: { dbId: string; instance: SQLiteSyncDevtoolsInstance["instance"] }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const handleExport = () => {
    try {
      const data = instance.exportData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${dbId}-${data.exportedAt.replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      const rowCount = Object.values(data.tables).reduce((sum, rows) => sum + rows.length, 0);
      setStatus({ kind: "success", message: `Exported ${rowCount} row${rowCount === 1 ? "" : "s"}.` });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleImportFile = async (file: File) => {
    setIsImporting(true);
    setStatus(null);
    try {
      const data = JSON.parse(await file.text()) as SyncedDbExport;
      const result = await instance.importData(data);
      setStatus({ kind: "success", message: `Imported ${result.imported} row${result.imported === 1 ? "" : "s"}.` });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="overviewSection">
      <div className="overviewSectionTitle">Backup &amp; Restore</div>
      <div className="dangerZoneDesc">
        Export the active rows of every CRDT table as JSON, or import a dump to seed/restore. Import overwrites rows
        with matching ids and is propagated to the server.
      </div>
      <div className="dataActions">
        <button type="button" className="dataButton" onClick={handleExport}>
          ↓ Export JSON
        </button>
        <button
          type="button"
          className="dataButton"
          disabled={isImporting}
          onClick={() => fileInputRef.current?.click()}
        >
          {isImporting ? "Importing…" : "↑ Import JSON"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hiddenInput"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleImportFile(file);
          }}
        />
      </div>
      {status && (
        <div className={status.kind === "error" ? "dataStatusError" : "dataStatusSuccess"}>{status.message}</div>
      )}
    </div>
  );
}

function ResetSection({ dbId, instance }: { dbId: string; instance: SQLiteSyncDevtoolsInstance["instance"] }) {
  const [confirming, setConfirming] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleReset = () => {
    setIsResetting(true);
    // Worker-owned clean reset: durably records a reset epoch, broadcasts a
    // reload to all tabs, and the next elected worker wipes the persisted DB.
    // The promise may never settle — the page unloads first.
    void instance.requestReload({ clean: true });
  };

  return (
    <div className="dangerZone">
      <div className="dangerZoneTitle">Danger Zone</div>
      <div className="dangerZoneRow">
        <div className="dangerZoneDesc">
          Requests a clean reload, so <code className="inlineCode">{dbId}</code> is wiped on next load via{" "}
          <code className="inlineCode">clearOnInit</code>, then reloads all tabs.
        </div>
        {confirming ? (
          <div className="dangerZoneActions">
            <button
              type="button"
              className="resetCancelButton"
              disabled={isResetting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button type="button" className="resetConfirmButton" disabled={isResetting} onClick={handleReset}>
              {isResetting ? "Resetting…" : "Confirm reset"}
            </button>
          </div>
        ) : (
          <button type="button" className="resetButton" onClick={() => setConfirming(true)}>
            Reset DB
          </button>
        )}
      </div>
    </div>
  );
}

const SYSTEM_COLUMNS = new Set(["id", "tombstone"]);

function formatDefaultValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function SchemaTab({ selectedInstance }: { selectedInstance: SQLiteSyncDevtoolsInstance | null }) {
  if (!selectedInstance) return null;

  const { tables, schemaVersion } = selectedInstance.instance._internal;
  const tableEntries = Object.entries(tables);

  return (
    <div className="schemaLayout">
      <div className="schemaSection">
        <div className="schemaSectionHeader">
          <div className="schemaSectionTitle">Tables</div>
          <span className="schemaBadge">{tableEntries.length}</span>
          <span className="schemaVersionChip mlAuto" title="Latest applied migration version">
            applied v{schemaVersion}
          </span>
        </div>
        {tableEntries.length === 0 ? (
          <div className="schemaEmpty">No tables declared on this schema.</div>
        ) : (
          <div className="schemaTableList">
            {tableEntries.map(([crdtTableName, table]) => {
              const baseTableName = table.baseName ?? `_${crdtTableName}`;
              const columns = Object.entries(table.columns);
              return (
                <div key={crdtTableName} className="schemaTableCard">
                  <div className="schemaTableCardHeader">
                    <div className="schemaTableCardTitleRow">
                      <div className="schemaTableCardName">{crdtTableName}</div>
                      <span className="schemaBadge">{columns.length}</span>
                    </div>
                    {table.description ? <p className="schemaTableCardDescription">{table.description}</p> : null}
                    <div className="schemaTableCardMeta">
                      <span className="schemaPolicyChip" title="Base table">
                        {baseTableName}
                      </span>
                      <span
                        className="schemaPolicyChip"
                        data-tone={table.writeOrigin === "server" ? "warn" : undefined}
                        title="Who may write CRDT events"
                      >
                        writes {table.writeOrigin}
                      </span>
                      <span
                        className="schemaPolicyChip"
                        data-tone={table.aiAccess === "read-write" ? undefined : "warn"}
                        title="AI agent access"
                      >
                        ai {table.aiAccess}
                      </span>
                      <span
                        className="schemaPolicyChip"
                        data-tone={table.exportImport === "ignore" ? "warn" : undefined}
                        title="Export / import"
                      >
                        export {table.exportImport}
                      </span>
                    </div>
                  </div>
                  <div className="schemaColumnGrid">
                    <div className="schemaColumnRow schemaColumnHeaderRow">
                      <div className="schemaColHeader">Column</div>
                      <div className="schemaColHeader">Type</div>
                      <div className="schemaColHeader">Flags</div>
                      <div className="schemaColHeader">Description</div>
                    </div>
                    {columns.map(([name, meta]) => (
                      <SchemaColumnRow key={name} name={name} meta={meta} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SchemaColumnRow({ name, meta }: { name: string; meta: ColumnMeta }) {
  const flags: string[] = [];
  if (name === "id") flags.push("pk");
  if (meta.nullable) flags.push("nullable");
  if (meta.hasDefault) flags.push(`default ${formatDefaultValue(meta.defaultValue)}`);

  return (
    <div className="schemaColumnRow" data-system={SYSTEM_COLUMNS.has(name) ? "true" : undefined}>
      <div className="schemaColumnName">{name}</div>
      <div className="schemaColumnType">
        <span>{meta.kind}</span>
        {meta.kind === "boolean" ? <span className="schemaColumnTypeDetail">integer 0/1</span> : null}
        {meta.kind === "enum" && meta.enumValues && meta.enumValues.length > 0 ? (
          <span className="schemaColumnTypeDetail">{meta.enumValues.map((value) => `"${value}"`).join(" | ")}</span>
        ) : null}
      </div>
      <div className="schemaColumnFlags">{flags.length > 0 ? flags.join(" · ") : "—"}</div>
      <div className="schemaColumnDescription">{meta.description ?? ""}</div>
    </div>
  );
}

function LiveQueriesTab({ selectedInstance }: { selectedInstance: SQLiteSyncDevtoolsInstance | null }) {
  const [queries, setQueries] = useState<SharedLiveQuerySnapshot[]>([]);

  const refresh = useCallback(() => {
    if (!selectedInstance) {
      setQueries([]);
      return;
    }

    setQueries(
      selectedInstance.instance._internal
        .getSharedLiveQueriesSnapshot()
        .sort(
          (a, b) =>
            a.sql.localeCompare(b.sql) ||
            formatLiveQueryParameters(a.parameters).localeCompare(formatLiveQueryParameters(b.parameters)),
        ),
    );
  }, [selectedInstance]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totalSubscribers = queries.reduce((total, query) => total + query.subscriberCount, 0);

  return (
    <div className="schemaLayout">
      <div className="schemaSection">
        <div className="schemaSectionHeader">
          <div className="schemaSectionTitle">Shared Live Queries</div>
          <span className="schemaBadge">{queries.length}</span>
          <span className="schemaVersionChip">
            {totalSubscribers} subscriber{totalSubscribers !== 1 ? "s" : ""}
          </span>
          <button type="button" className="refreshButton mlAuto" onClick={refresh} disabled={!selectedInstance}>
            ↻ Refresh
          </button>
        </div>
        {queries.length === 0 ? (
          <div className="schemaEmpty">
            No active live queries. Queries created via <code className="inlineCode">useDbQuery</code> appear here while
            components are subscribed.
          </div>
        ) : (
          <div className="schemaTableGrid">
            <div className="liveQueryHeaderRow">
              <div className="schemaColHeader">SQL</div>
              <div className="schemaColHeader">Parameters</div>
              <div className="schemaColHeader alignCenter">Subscribers</div>
            </div>
            {queries.map((query) => {
              const parameters = formatLiveQueryParameters(query.parameters);
              return (
                <div key={`${query.sql}|${parameters}`} className="liveQueryRow">
                  <div className="liveQuerySql">{query.sql}</div>
                  <div className="liveQueryParameters">{parameters}</div>
                  <div className="schemaStatusCell">
                    <span className={query.subscriberCount > 0 ? "schemaActiveTag" : "liveQueryIdleTag"}>
                      {query.subscriberCount}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatLiveQueryParameters(parameters: readonly unknown[]): string {
  try {
    return JSON.stringify(parameters);
  } catch {
    return String(parameters);
  }
}

type PersistedCrdtEvent = {
  sync_id: number;
  schema_version: number;
  status: "pending" | "applied" | "failed" | "deduped";
  type: "item-created" | "item-updated" | "item-deleted";
  timestamp: string;
  origin: "remote" | "own" | "local";
  source_node_id: string;
  dataset: string;
  item_id: string;
  payload: string;
};

function isPersistedCrdtEvent(value: unknown): value is PersistedCrdtEvent {
  if (typeof value !== "object" || value === null) return false;
  return (
    "sync_id" in value &&
    typeof value.sync_id === "number" &&
    "status" in value &&
    typeof value.status === "string" &&
    "type" in value &&
    typeof value.type === "string" &&
    "origin" in value &&
    typeof value.origin === "string" &&
    "dataset" in value &&
    typeof value.dataset === "string" &&
    "item_id" in value &&
    typeof value.item_id === "string" &&
    "payload" in value &&
    typeof value.payload === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "string"
  );
}

type EventLogFilters = {
  dataset: string;
  origin: string;
  status: string;
};

const PAGE_SIZE = 50;

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function eventLogWhereClause(filters: EventLogFilters, afterSyncId: number | null): string {
  const conditions: string[] = [];

  if (filters.dataset) conditions.push(`dataset = ${sqlStringLiteral(filters.dataset)}`);
  if (filters.origin) conditions.push(`origin = ${sqlStringLiteral(filters.origin)}`);
  if (filters.status) conditions.push(`status = ${sqlStringLiteral(filters.status)}`);
  if (afterSyncId !== null) conditions.push(`sync_id < ${afterSyncId}`);

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}

function buildEventLogQuery(filters: EventLogFilters, afterSyncId: number | null): string {
  return `SELECT * FROM "worker"."crdt_events" ${eventLogWhereClause(filters, afterSyncId)} ORDER BY sync_id DESC LIMIT ${PAGE_SIZE + 1}`;
}

function buildEventLogCountQuery(filters: EventLogFilters): string {
  return `SELECT COUNT(*) AS count FROM "worker"."crdt_events" ${eventLogWhereClause(filters, null)}`;
}

function EventLogTab({ selectedInstance }: { selectedInstance: SQLiteSyncDevtoolsInstance | null }) {
  const baseTableNames = useMemo(
    () => selectedInstance?.instance._internal.crdtTablesConfig.map((table) => table.baseTableName) ?? [],
    [selectedInstance],
  );

  const [filters, setFilters] = useState<EventLogFilters>({ dataset: "", origin: "", status: "" });
  const [events, setEvents] = useState<PersistedCrdtEvent[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const afterSyncIdRef = useRef<number | null>(null);
  const isLoadingRef = useRef(false);

  const executeRows = useCallback(
    async (sql: string): Promise<unknown[]> => {
      if (!selectedInstance) return [];
      const result = await selectedInstance.instance._internal.executeAsync({ sql, parameters: [] });
      return result.rows;
    },
    [selectedInstance],
  );

  const load = useCallback(
    async (reset: boolean, currentFilters: EventLogFilters) => {
      if (!selectedInstance || isLoadingRef.current) return;
      isLoadingRef.current = true;
      setIsLoading(true);
      try {
        const afterSyncId = reset ? null : afterSyncIdRef.current;
        const sql = buildEventLogQuery(currentFilters, afterSyncId);
        const rowsPromise = executeRows(sql);
        const countPromise = reset ? executeRows(buildEventLogCountQuery(currentFilters)) : Promise.resolve(null);
        const [rows, countRows] = await Promise.all([rowsPromise, countPromise]);
        const page = rows.filter(isPersistedCrdtEvent).slice(0, PAGE_SIZE);
        setHasMore(rows.length > PAGE_SIZE);
        if (reset) {
          setEvents(page);
          setTotalCount(countRows ? readCount(countRows) : null);
        } else {
          setEvents((prev) => [...prev, ...page]);
        }
        afterSyncIdRef.current = page.at(-1)?.sync_id ?? null;
      } finally {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    },
    [selectedInstance, executeRows],
  );

  // Initial load and reload on instance or filter change
  useEffect(() => {
    afterSyncIdRef.current = null;
    setEvents([]);
    setTotalCount(null);
    void load(true, filters);
  }, [filters, load]);

  const applyFilters = (next: EventLogFilters) => {
    setFilters(next);
  };

  if (!selectedInstance) return null;

  return (
    <div className="eventLogLayout">
      {/* Toolbar */}
      <div className="eventLogToolbar">
        <select
          value={filters.dataset}
          onChange={(e) => applyFilters({ ...filters, dataset: e.target.value })}
          className="eventLogFilterSelect"
        >
          <option value="">All datasets</option>
          {baseTableNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={filters.origin}
          onChange={(e) => applyFilters({ ...filters, origin: e.target.value })}
          className="eventLogFilterSelect"
        >
          <option value="">All origins</option>
          <option value="own">own</option>
          <option value="remote">remote</option>
          <option value="local">local</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => applyFilters({ ...filters, status: e.target.value })}
          className="eventLogFilterSelect"
        >
          <option value="">All statuses</option>
          <option value="applied">applied</option>
          <option value="pending">pending</option>
          <option value="failed">failed</option>
          <option value="deduped">deduped</option>
        </select>
        <button type="button" className="refreshButton" disabled={isLoading} onClick={() => void load(true, filters)}>
          {isLoading ? "…" : "↻"} Refresh
        </button>
        {totalCount !== null && (
          <span className="eventLogCount">
            {events.length === totalCount
              ? `${totalCount} event${totalCount === 1 ? "" : "s"}`
              : `${events.length} of ${totalCount}`}
          </span>
        )}
      </div>

      {/* Event list */}
      {events.length === 0 && !isLoading ? (
        <div className="eventLogEmpty">No events match the current filters.</div>
      ) : (
        <div className="eventLogList">
          {events.map((event) => {
            const isExpanded = expandedId === event.sync_id;
            return (
              <div key={event.sync_id} className="eventRow" data-expanded={isExpanded ? "true" : undefined}>
                <button
                  type="button"
                  className="eventRowHeader"
                  onClick={() => setExpandedId(isExpanded ? null : event.sync_id)}
                >
                  <span className="eventSyncId">#{event.sync_id}</span>
                  <EventTypeBadge type={event.type} />
                  <EventOriginBadge origin={event.origin} />
                  <EventStatusBadge status={event.status} />
                  <span className="eventDataset">{event.dataset}</span>
                  <span className="eventItemId">{event.item_id}</span>
                  <span className="eventTimestamp">{formatHlcTimestamp(event.timestamp)}</span>
                  <span className="eventChevron">{isExpanded ? "▲" : "▼"}</span>
                </button>

                {isExpanded && (
                  <div className="eventPayload">
                    <div className="eventPayloadMeta">
                      <span className="eventMetaItem">schema v{event.schema_version}</span>
                      <span className="eventMetaItem">node: {event.source_node_id || "—"}</span>
                      <span className="eventMetaItem">ts: {event.timestamp}</span>
                    </div>
                    <pre className="eventPayloadPre">{formatPayload(event.payload)}</pre>
                  </div>
                )}
              </div>
            );
          })}

          {hasMore && (
            <button
              type="button"
              className="loadMoreButton"
              disabled={isLoading}
              onClick={() => void load(false, filters)}
            >
              {isLoading ? "Loading…" : `Load ${PAGE_SIZE} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EventTypeBadge({ type }: { type: string }) {
  const { variant, label } =
    type === "item-created"
      ? { variant: "create", label: "create" }
      : type === "item-deleted"
        ? { variant: "delete", label: "delete" }
        : { variant: "update", label: "update" };
  return (
    <span className="eventBadge" data-variant={variant}>
      {label}
    </span>
  );
}

function EventOriginBadge({ origin }: { origin: string }) {
  const variant = origin === "own" ? "own" : origin === "remote" ? "remote" : "local";
  return (
    <span className="eventBadge" data-variant={variant}>
      {origin}
    </span>
  );
}

function EventStatusBadge({ status }: { status: string }) {
  const variant =
    status === "applied" ? "applied" : status === "pending" ? "pending" : status === "failed" ? "failed" : "skipped";
  return (
    <span className="eventBadge" data-variant={variant}>
      {status}
    </span>
  );
}

function formatHlcTimestamp(ts: string): string {
  // HLC format: "<unix_ms>-<counter>-<node>" or just an ISO string
  const ms = Number(ts.split("-")[0]);
  if (!Number.isNaN(ms) && ms > 1e12) {
    return new Date(ms).toLocaleTimeString();
  }
  return ts.slice(0, 19).replace("T", " ");
}

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function QueryRunnerTab({
  selectedInstance,
  queryTarget,
  setQueryTarget,
  query,
  setQuery,
  queryState,
  canRunQuery,
  runQuery,
}: {
  selectedInstance: unknown;
  queryTarget: QueryTarget;
  setQueryTarget: (t: QueryTarget) => void;
  query: string;
  setQuery: (q: string) => void;
  queryState: QueryState;
  canRunQuery: boolean;
  runQuery: () => Promise<void>;
}) {
  return (
    <div className="queryRunnerLayout">
      {/* Top toolbar */}
      <div className="queryToolbar">
        <div className="targetToggle">
          <button
            type="button"
            className="targetButton"
            data-active={queryTarget === "memory" ? "true" : undefined}
            onClick={() => setQueryTarget("memory")}
          >
            Memory DB
          </button>
          <button
            type="button"
            className="targetButton"
            data-active={queryTarget === "worker" ? "true" : undefined}
            onClick={() => setQueryTarget("worker")}
          >
            Worker DB
          </button>
        </div>

        <div className="queryToolbarRight">
          {!selectedInstance && <span className="noInstanceWarning">No instance selected</span>}
          <span className="shortcutHint">⌘↵ to run</span>
          <button
            type="button"
            className="runButton"
            data-enabled={canRunQuery ? "true" : undefined}
            data-running={queryState.status === "running" ? "true" : undefined}
            disabled={!canRunQuery}
            onClick={() => void runQuery()}
          >
            {queryState.status === "running" ? (
              <>
                <span className="runningDot" />
                Running…
              </>
            ) : (
              <>▶ Run</>
            )}
          </button>
        </div>
      </div>

      {/* SQL textarea */}
      <div className="editorWrapper">
        <textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canRunQuery) {
              event.preventDefault();
              void runQuery();
            }
          }}
          className="textarea"
          placeholder="SELECT * FROM your_table LIMIT 100"
          spellCheck={false}
        />
      </div>

      {/* Constraint hint */}
      <div className="helperText">
        {queryTarget === "worker"
          ? "Worker DB is read-only — only SELECT, PRAGMA, and EXPLAIN are allowed."
          : "Memory DB allows writes only to CRDT tables."}
      </div>

      {/* Results */}
      {queryState.status === "error" && (
        <div className="errorPanel">
          <div className="resultHeader">
            <span className="errorBadge">Error</span>
            <span className="resultMeta">
              {queryState.error.target} · {queryState.error.sql}
            </span>
          </div>
          <pre className="errorMessage">{queryState.error.message}</pre>
        </div>
      )}

      {queryState.status === "success" && (
        <div className="resultPanel">
          <div className="resultHeader">
            <span className="successBadge">
              {queryState.output.rowCount} row{queryState.output.rowCount !== 1 ? "s" : ""}
            </span>
            <span className="resultMeta">
              {queryState.output.target} · {queryState.output.durationMs}ms
            </span>
          </div>
          <ResultTable rows={queryState.output.rows} />
        </div>
      )}
    </div>
  );
}

function ResultTable({ rows }: { rows: unknown[] }) {
  if (rows.length === 0) {
    return <div className="resultEmpty">Query returned 0 rows.</div>;
  }

  const firstRow = rows[0];
  if (typeof firstRow !== "object" || firstRow === null) {
    return <pre className="resultRaw">{JSON.stringify(rows, null, 2)}</pre>;
  }

  const columns = Object.keys(firstRow as object);

  return (
    <div className="tableWrapper">
      <table className="table">
        <thead>
          <tr>
            <th className="thRowNum">#</th>
            {columns.map((col) => (
              <th key={col} className="th">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              <td className="tdRowNum">{rowIdx + 1}</td>
              {columns.map((col) => {
                const val = (row as Record<string, unknown>)[col];
                return (
                  <td key={col} className="td">
                    {val === null ? (
                      <span className="nullValue">NULL</span>
                    ) : typeof val === "object" ? (
                      <span className="jsonValue">{JSON.stringify(val)}</span>
                    ) : (
                      String(val)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatInstanceLabel(dbId: string, instanceId: string, duplicateCount: number): string {
  if (duplicateCount < 2) {
    return dbId;
  }

  return `${dbId} (${instanceId.slice(0, 6)})`;
}

function normalizeSingleStatement(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Enter a SQL statement.");
  }

  const withoutTrailingSemicolons = trimmed.replace(/;+\s*$/u, "");
  if (withoutTrailingSemicolons.includes(";")) {
    throw new Error("Devtools only supports a single SQL statement.");
  }

  return withoutTrailingSemicolons;
}

function getStatementKind(query: string): string {
  const match = query.trimStart().match(/^([a-z]+)/iu);
  return match?.[1]?.toLowerCase() ?? "";
}

function isWorkerReadOnlyStatement(statementKind: string): boolean {
  return statementKind === "select" || statementKind === "pragma";
}

function getEmptySnapshot(): SQLiteSyncDevtoolsSnapshot {
  return emptySnapshot;
}

const emptySnapshot: SQLiteSyncDevtoolsSnapshot = {
  instances: [],
};
