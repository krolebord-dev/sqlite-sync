import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  getOrCreateSQLiteSyncDevtoolsRegistry,
  type SQLiteSyncDevtoolsInstance,
  type SQLiteSyncDevtoolsSnapshot,
} from "./devtools-registry";

type SQLiteSyncDevtoolsProps = {
  className?: string;
};

type DevtoolsTab = "overview" | "schema" | "event-log" | "query-runner";
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

export function SQLiteSyncDevtools({ className }: SQLiteSyncDevtoolsProps) {
  const registry = getOrCreateSQLiteSyncDevtoolsRegistry();
  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, getEmptySnapshot);
  const instances = snapshot.instances;

  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DevtoolsTab>("overview");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [queryTarget, setQueryTarget] = useState<QueryTarget>("memory");
  const [query, setQuery] = useState("");
  const [queryState, setQueryState] = useState<QueryState>({
    status: "idle",
  });

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
    <>
      <div style={floatingRootStyles}>
        <button type="button" style={triggerButtonStyles} onClick={() => setIsOpen(true)} title="SQLite Sync Devtools">
          <span style={triggerIconStyles}>◈</span>
          <span style={triggerCountStyles}>{instances.length}</span>
        </button>
      </div>

      {isOpen ? (
        <div style={overlayStyles} onClick={() => setIsOpen(false)}>
          <section
            className={className}
            role="dialog"
            aria-modal="true"
            aria-label="SQLite Sync devtools"
            style={dialogStyles}
            onClick={(event) => event.stopPropagation()}
          >
            {/* Dialog header */}
            <div style={headerStyles}>
              <div style={headerLeftStyles}>
                <span style={headerLogoStyles}>◈</span>
                <div>
                  <div style={eyebrowStyles}>sqlite-sync</div>
                  <h2 style={titleStyles}>Devtools</h2>
                </div>
              </div>

              <div style={headerRightStyles}>
                {instances.length > 0 && (
                  <label style={instancePickerLabelStyles}>
                    <span style={instancePickerTextStyles}>DB</span>
                    <select
                      value={selectedInstanceId}
                      onChange={(event) => setSelectedInstanceId(event.target.value)}
                      style={instancePickerSelectStyles}
                    >
                      {instances.map((instance) => (
                        <option key={instance.instanceId} value={instance.instanceId}>
                          {formatInstanceLabel(instance.dbId, instance.instanceId, dbIdCounts.get(instance.dbId) ?? 0)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span style={instanceCountBadgeStyles}>
                  {instances.length} instance{instances.length !== 1 ? "s" : ""}
                </span>
                <button type="button" style={closeButtonStyles} onClick={() => setIsOpen(false)} aria-label="Close">
                  ✕
                </button>
              </div>
            </div>

            {instances.length === 0 ? (
              <div style={emptyStateStyles}>
                <div style={emptyStateIconStyles}>◈</div>
                <p style={emptyStateTextStyles}>No SQLite Sync database instances registered.</p>
                <p style={emptyStateSubtextStyles}>
                  Call <code style={inlineCodeStyles}>registerDevtools(db)</code> in your app to get started.
                </p>
              </div>
            ) : (
              <div style={contentLayoutStyles}>
                {/* Sidebar nav */}
                <aside style={sidebarStyles}>
                  <nav style={navStyles}>
                    <button
                      type="button"
                      style={getTabButtonStyles(activeTab === "overview")}
                      onClick={() => setActiveTab("overview")}
                    >
                      <span style={navIconStyles}>▦</span>
                      Overview
                    </button>
                    <button
                      type="button"
                      style={getTabButtonStyles(activeTab === "schema")}
                      onClick={() => setActiveTab("schema")}
                    >
                      <span style={navIconStyles}>⬡</span>
                      Schema
                    </button>
                    <button
                      type="button"
                      style={getTabButtonStyles(activeTab === "event-log")}
                      onClick={() => setActiveTab("event-log")}
                    >
                      <span style={navIconStyles}>≡</span>
                      Event Log
                    </button>
                    <button
                      type="button"
                      style={getTabButtonStyles(activeTab === "query-runner")}
                      onClick={() => setActiveTab("query-runner")}
                    >
                      <span style={navIconStyles}>▶</span>
                      Query Runner
                    </button>
                  </nav>

                  {selectedInstance && (
                    <div style={sidebarInfoStyles}>
                      <div style={sidebarInfoLabelStyles}>Active instance</div>
                      <div style={sidebarInfoValueStyles}>
                        {formatInstanceLabel(
                          selectedInstance.dbId,
                          selectedInstance.instanceId,
                          dbIdCounts.get(selectedInstance.dbId) ?? 0,
                        )}
                      </div>
                      <div style={sidebarInfoSubStyles}>id: {selectedInstance.instanceId.slice(0, 12)}…</div>
                    </div>
                  )}
                </aside>

                {/* Main pane */}
                <div style={mainPaneStyles}>
                  {activeTab === "overview" ? (
                    <OverviewTab selectedInstance={selectedInstance} dbIdCounts={dbIdCounts} />
                  ) : activeTab === "schema" ? (
                    <SchemaTab selectedInstance={selectedInstance} />
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
    </>
  );
}

const EVENT_HLC_ACCUMULATOR_KV_KEY = "crdt.consistency.event_hlc_sum.v2";
const EVENT_HLC_ACCUMULATOR_QUERY = `SELECT value FROM "worker"."kv" WHERE key = '${EVENT_HLC_ACCUMULATOR_KV_KEY}'`;

function OverviewTab({
  selectedInstance,
  dbIdCounts,
}: {
  selectedInstance: ReturnType<typeof getOrCreateSQLiteSyncDevtoolsRegistry>["getSnapshot"] extends () => {
    instances: infer I;
  }
    ? I extends readonly (infer T)[]
      ? T | null
      : never
    : never;
  dbIdCounts: Map<string, number>;
}) {
  const [eventHlcAccumulator, setEventHlcAccumulator] = useState<string | null>(null);
  const [accumulatorError, setAccumulatorError] = useState<string | null>(null);
  const [isAccumulatorLoading, setIsAccumulatorLoading] = useState(false);

  const refreshEventHlcAccumulator = useCallback(async () => {
    if (!selectedInstance) return;
    setIsAccumulatorLoading(true);
    setAccumulatorError(null);
    try {
      const result = await selectedInstance.instance._internal.executeAsync({
        sql: EVENT_HLC_ACCUMULATOR_QUERY,
        parameters: [],
      });
      const row = result.rows[0] as { value?: string } | undefined;
      setEventHlcAccumulator(row?.value ?? "");
    } catch (error) {
      setAccumulatorError(error instanceof Error ? error.message : String(error));
      setEventHlcAccumulator(null);
    } finally {
      setIsAccumulatorLoading(false);
    }
  }, [selectedInstance]);

  useEffect(() => {
    setEventHlcAccumulator(null);
    setAccumulatorError(null);
    void refreshEventHlcAccumulator();
  }, [refreshEventHlcAccumulator]);

  if (!selectedInstance) return null;

  const label = formatInstanceLabel(
    selectedInstance.dbId,
    selectedInstance.instanceId,
    dbIdCounts.get(selectedInstance.dbId) ?? 0,
  );

  const crdtTables = selectedInstance.instance._internal.crdtTableNames;

  return (
    <div style={overviewLayoutStyles}>
      <div style={overviewCardsRowStyles}>
        <div style={overviewCardStyles}>
          <div style={overviewCardLabelStyles}>Database</div>
          <div style={overviewCardValueStyles}>{label}</div>
        </div>
        <div style={overviewCardStyles}>
          <div style={overviewCardLabelStyles}>Instance ID</div>
          <div style={{ ...overviewCardValueStyles, fontFamily: "ui-monospace, monospace", fontSize: "0.78rem" }}>
            {selectedInstance.instanceId.slice(0, 16)}…
          </div>
        </div>
        <div style={overviewCardStyles}>
          <div style={overviewCardLabelStyles}>CRDT Tables</div>
          <div style={overviewCardValueStyles}>{crdtTables.length}</div>
        </div>
      </div>

      <div style={overviewSectionStyles}>
        <div style={overviewSectionTitleStyles}>CRDT Tables</div>
        {crdtTables.length === 0 ? (
          <div style={overviewEmptyStyles}>No CRDT tables registered.</div>
        ) : (
          <div style={crdtTableListStyles}>
            {[...crdtTables].map((name) => (
              <div key={name} style={crdtTableRowStyles}>
                <span style={crdtTableIconStyles}>▦</span>
                <span style={crdtTableNameStyles}>{name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={overviewSectionStyles}>
        <div style={overviewSectionHeaderStyles}>
          <div style={overviewSectionTitleStyles}>Event HLC accumulator</div>
          <button
            type="button"
            style={overviewRefreshButtonStyles}
            disabled={isAccumulatorLoading}
            onClick={() => void refreshEventHlcAccumulator()}
          >
            {isAccumulatorLoading ? "…" : "↻"} Refresh
          </button>
        </div>
        <div style={overviewAccumulatorValueStyles}>
          {accumulatorError ? (
            <span style={overviewAccumulatorErrorStyles}>{accumulatorError}</span>
          ) : isAccumulatorLoading && eventHlcAccumulator === null ? (
            "Loading…"
          ) : eventHlcAccumulator === "" ? (
            <span style={overviewAccumulatorEmptyStyles}>(empty)</span>
          ) : (
            eventHlcAccumulator
          )}
        </div>
      </div>

      <div style={overviewSectionStyles}>
        <div style={overviewSectionTitleStyles}>Write Permissions</div>
        <div style={permissionRowStyles}>
          <span style={permissionIconStyles}>✓</span>
          <span style={permissionTextStyles}>Memory DB — CRDT tables only</span>
        </div>
        <div style={permissionRowStyles}>
          <span style={{ ...permissionIconStyles, color: "#f59e0b" }}>⊘</span>
          <span style={permissionTextStyles}>Worker DB — read-only (SELECT, PRAGMA, EXPLAIN)</span>
        </div>
      </div>

      <ResetSection dbId={selectedInstance.dbId} instance={selectedInstance.instance} />
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
    <div style={dangerZoneStyles}>
      <div style={dangerZoneTitleStyles}>Danger Zone</div>
      <div style={dangerZoneRowStyles}>
        <div style={dangerZoneDescStyles}>
          Requests a clean reload, so <code style={inlineCodeStyles}>{dbId}</code> is wiped on next load via{" "}
          <code style={inlineCodeStyles}>clearOnInit</code>, then reloads all tabs.
        </div>
        {confirming ? (
          <div style={dangerZoneActionsStyles}>
            <button
              type="button"
              style={resetCancelButtonStyles}
              disabled={isResetting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button type="button" style={resetConfirmButtonStyles} disabled={isResetting} onClick={handleReset}>
              {isResetting ? "Resetting…" : "Confirm reset"}
            </button>
          </div>
        ) : (
          <button type="button" style={resetButtonStyles} onClick={() => setConfirming(true)}>
            Reset DB
          </button>
        )}
      </div>
    </div>
  );
}

function SchemaTab({
  selectedInstance,
}: {
  selectedInstance: ReturnType<typeof getOrCreateSQLiteSyncDevtoolsRegistry>["getSnapshot"] extends () => {
    instances: infer I;
  }
    ? I extends readonly (infer T)[]
      ? T | null
      : never
    : never;
}) {
  if (!selectedInstance) return null;

  const { crdtTablesConfig, schemaVersion, migrationVersions } = selectedInstance.instance._internal;
  const latestVersion = migrationVersions.at(-1) ?? 0;

  return (
    <div style={schemaLayoutStyles}>
      {/* CRDT Tables */}
      <div style={schemaSectionStyles}>
        <div style={schemaSectionHeaderStyles}>
          <div style={schemaSectionTitleStyles}>CRDT Tables</div>
          <span style={schemaBadgeStyles}>{crdtTablesConfig.length}</span>
        </div>
        <div style={schemaTableGridStyles}>
          <div style={schemaTableHeaderRowStyles}>
            <div style={schemaColHeaderStyles}>Base Table</div>
            <div style={schemaColHeaderStyles}>CRDT Table</div>
            <div style={{ ...schemaColHeaderStyles, textAlign: "center" }}>Status</div>
          </div>
          {crdtTablesConfig.map((table) => (
            <div key={table.crdtTableName} style={schemaTableRowStyles}>
              <div style={schemaTableNameStyles}>
                <span style={schemaTableIconStyles}>▦</span>
                {table.baseTableName}
              </div>
              <div style={schemaCrdtNameStyles}>{table.crdtTableName}</div>
              <div style={schemaStatusCellStyles}>
                <span style={schemaActiveTagStyles}>active</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Migrations */}
      <div style={schemaSectionStyles}>
        <div style={schemaSectionHeaderStyles}>
          <div style={schemaSectionTitleStyles}>Migrations</div>
          <div style={schemaMigrationsMetaStyles}>
            <span style={schemaBadgeStyles}>{migrationVersions.length} total</span>
            <span style={schemaVersionChipStyles}>
              current: v{schemaVersion} / latest: v{latestVersion}
            </span>
          </div>
        </div>
        {migrationVersions.length === 0 ? (
          <div style={schemaEmptyStyles}>No migrations defined.</div>
        ) : (
          <div style={migrationListStyles}>
            {migrationVersions.map((version) => {
              const applied = version <= schemaVersion;
              const isCurrent = version === schemaVersion;
              return (
                <div key={version} style={getMigrationRowStyles(applied)}>
                  <div style={migrationVersionStyles}>v{version}</div>
                  <div style={migrationBarTrackStyles}>
                    <div style={getMigrationBarFillStyles(applied)} />
                  </div>
                  <div style={getMigrationTagStyles(applied, isCurrent)}>
                    {isCurrent ? "current" : applied ? "applied" : "pending"}
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

type PersistedCrdtEvent = {
  sync_id: number;
  schema_version: number;
  status: "pending" | "applied" | "failed" | "deduped";
  type: "item-created" | "item-updated";
  timestamp: string;
  origin: "remote" | "own" | "local";
  source_node_id: string;
  dataset: string;
  item_id: string;
  payload: string;
};

type EventLogFilters = {
  dataset: string;
  origin: string;
  status: string;
};

const PAGE_SIZE = 50;

function buildEventLogQuery(filters: EventLogFilters, afterSyncId: number | null): string {
  const conditions: string[] = [];

  if (filters.dataset) conditions.push(`dataset = '${filters.dataset}'`);
  if (filters.origin) conditions.push(`origin = '${filters.origin}'`);
  if (filters.status) conditions.push(`status = '${filters.status}'`);
  if (afterSyncId !== null) conditions.push(`sync_id < ${afterSyncId}`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return `SELECT * FROM "worker"."crdt_events" ${where} ORDER BY sync_id DESC LIMIT ${PAGE_SIZE + 1}`;
}

function EventLogTab({
  selectedInstance,
}: {
  selectedInstance: ReturnType<typeof getOrCreateSQLiteSyncDevtoolsRegistry>["getSnapshot"] extends () => {
    instances: infer I;
  }
    ? I extends readonly (infer T)[]
      ? T | null
      : never
    : never;
}) {
  const baseTableNames = useMemo(
    () => selectedInstance?.instance._internal.crdtTablesConfig.map((table) => table.baseTableName) ?? [],
    [selectedInstance],
  );

  const [filters, setFilters] = useState<EventLogFilters>({ dataset: "", origin: "", status: "" });
  const [events, setEvents] = useState<PersistedCrdtEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const afterSyncIdRef = useRef<number | null>(null);
  const isLoadingRef = useRef(false);

  const executeQuery = useCallback(
    async (sql: string): Promise<PersistedCrdtEvent[]> => {
      if (!selectedInstance) return [];
      const result = await selectedInstance.instance._internal.executeAsync({ sql, parameters: [] });
      return result.rows as PersistedCrdtEvent[];
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
        const rows = await executeQuery(sql);
        const page = rows.slice(0, PAGE_SIZE);
        setHasMore(rows.length > PAGE_SIZE);
        if (reset) {
          setEvents(page);
        } else {
          setEvents((prev) => [...prev, ...page]);
        }
        afterSyncIdRef.current = page.at(-1)?.sync_id ?? null;
      } finally {
        isLoadingRef.current = false;
        setIsLoading(false);
      }
    },
    [selectedInstance, executeQuery],
  );

  // Initial load and reload on instance or filter change
  useEffect(() => {
    afterSyncIdRef.current = null;
    setEvents([]);
    void load(true, filters);
  }, [filters, load]);

  const applyFilters = (next: EventLogFilters) => {
    setFilters(next);
  };

  if (!selectedInstance) return null;

  return (
    <div style={eventLogLayoutStyles}>
      {/* Toolbar */}
      <div style={eventLogToolbarStyles}>
        <select
          value={filters.dataset}
          onChange={(e) => applyFilters({ ...filters, dataset: e.target.value })}
          style={eventLogFilterSelectStyles}
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
          style={eventLogFilterSelectStyles}
        >
          <option value="">All origins</option>
          <option value="own">own</option>
          <option value="remote">remote</option>
          <option value="local">local</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => applyFilters({ ...filters, status: e.target.value })}
          style={eventLogFilterSelectStyles}
        >
          <option value="">All statuses</option>
          <option value="applied">applied</option>
          <option value="pending">pending</option>
          <option value="failed">failed</option>
          <option value="deduped">deduped</option>
        </select>
        <button
          type="button"
          style={eventLogRefreshButtonStyles}
          disabled={isLoading}
          onClick={() => void load(true, filters)}
        >
          {isLoading ? "…" : "↻"} Refresh
        </button>
        {events.length > 0 && (
          <span style={eventLogCountStyles}>
            {events.length}
            {hasMore ? "+" : ""} events
          </span>
        )}
      </div>

      {/* Event list */}
      {events.length === 0 && !isLoading ? (
        <div style={eventLogEmptyStyles}>No events match the current filters.</div>
      ) : (
        <div style={eventLogListStyles}>
          {events.map((event) => {
            const isExpanded = expandedId === event.sync_id;
            return (
              <div key={event.sync_id} style={getEventRowStyles(isExpanded)}>
                <button
                  type="button"
                  style={eventRowHeaderStyles}
                  onClick={() => setExpandedId(isExpanded ? null : event.sync_id)}
                >
                  <span style={eventSyncIdStyles}>#{event.sync_id}</span>
                  <EventTypeBadge type={event.type} />
                  <EventOriginBadge origin={event.origin} />
                  <EventStatusBadge status={event.status} />
                  <span style={eventDatasetStyles}>{event.dataset}</span>
                  <span style={eventItemIdStyles}>{event.item_id}</span>
                  <span style={eventTimestampStyles}>{formatHlcTimestamp(event.timestamp)}</span>
                  <span style={eventChevronStyles}>{isExpanded ? "▲" : "▼"}</span>
                </button>

                {isExpanded && (
                  <div style={eventPayloadStyles}>
                    <div style={eventPayloadMetaStyles}>
                      <span style={eventMetaItemStyles}>schema v{event.schema_version}</span>
                      <span style={eventMetaItemStyles}>node: {event.source_node_id || "—"}</span>
                      <span style={eventMetaItemStyles}>ts: {event.timestamp}</span>
                    </div>
                    <pre style={eventPayloadPreStyles}>{formatPayload(event.payload)}</pre>
                  </div>
                )}
              </div>
            );
          })}

          {hasMore && (
            <button
              type="button"
              style={loadMoreButtonStyles}
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
  const isCreate = type === "item-created";
  return <span style={isCreate ? eventTypeCreateStyles : eventTypeUpdateStyles}>{isCreate ? "create" : "update"}</span>;
}

function EventOriginBadge({ origin }: { origin: string }) {
  const style =
    origin === "own" ? eventOriginOwnStyles : origin === "remote" ? eventOriginRemoteStyles : eventOriginLocalStyles;
  return <span style={style}>{origin}</span>;
}

function EventStatusBadge({ status }: { status: string }) {
  const style =
    status === "applied"
      ? eventStatusAppliedStyles
      : status === "pending"
        ? eventStatusPendingStyles
        : status === "failed"
          ? eventStatusFailedStyles
          : eventStatusSkippedStyles;
  return <span style={style}>{status}</span>;
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
    <div style={queryRunnerLayoutStyles}>
      {/* Top toolbar */}
      <div style={queryToolbarStyles}>
        <div style={targetToggleStyles}>
          <button
            type="button"
            style={getTargetButtonStyles(queryTarget === "memory")}
            onClick={() => setQueryTarget("memory")}
          >
            Memory DB
          </button>
          <button
            type="button"
            style={getTargetButtonStyles(queryTarget === "worker")}
            onClick={() => setQueryTarget("worker")}
          >
            Worker DB
          </button>
        </div>

        <div style={queryToolbarRightStyles}>
          {!selectedInstance && <span style={noInstanceWarningStyles}>No instance selected</span>}
          <span style={shortcutHintStyles}>⌘↵ to run</span>
          <button
            type="button"
            style={runButtonStyles(canRunQuery, queryState.status === "running")}
            disabled={!canRunQuery}
            onClick={() => void runQuery()}
          >
            {queryState.status === "running" ? (
              <>
                <span style={runningDotStyles} />
                Running…
              </>
            ) : (
              <>▶ Run</>
            )}
          </button>
        </div>
      </div>

      {/* SQL textarea */}
      <div style={editorWrapperStyles}>
        <textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canRunQuery) {
              event.preventDefault();
              void runQuery();
            }
          }}
          style={textareaStyles}
          placeholder="SELECT * FROM your_table LIMIT 100"
          spellCheck={false}
        />
      </div>

      {/* Constraint hint */}
      <div style={helperTextStyles}>
        {queryTarget === "worker"
          ? "Worker DB is read-only — only SELECT, PRAGMA, and EXPLAIN are allowed."
          : "Memory DB allows writes only to CRDT tables."}
      </div>

      {/* Results */}
      {queryState.status === "error" && (
        <div style={errorPanelStyles}>
          <div style={resultHeaderStyles}>
            <span style={errorBadgeStyles}>Error</span>
            <span style={resultMetaStyles}>
              {queryState.error.target} · {queryState.error.sql}
            </span>
          </div>
          <pre style={errorMessageStyles}>{queryState.error.message}</pre>
        </div>
      )}

      {queryState.status === "success" && (
        <div style={resultPanelStyles}>
          <div style={resultHeaderStyles}>
            <span style={successBadgeStyles}>
              {queryState.output.rowCount} row{queryState.output.rowCount !== 1 ? "s" : ""}
            </span>
            <span style={resultMetaStyles}>
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
    return <div style={resultEmptyStyles}>Query returned 0 rows.</div>;
  }

  const firstRow = rows[0];
  if (typeof firstRow !== "object" || firstRow === null) {
    return <pre style={resultRawStyles}>{JSON.stringify(rows, null, 2)}</pre>;
  }

  const columns = Object.keys(firstRow as object);

  return (
    <div style={tableWrapperStyles}>
      <table style={tableStyles}>
        <thead>
          <tr>
            <th style={thRowNumStyles}>#</th>
            {columns.map((col) => (
              <th key={col} style={thStyles}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx} style={rowIdx % 2 === 0 ? trStyles : trAltStyles}>
              <td style={tdRowNumStyles}>{rowIdx + 1}</td>
              {columns.map((col) => {
                const val = (row as Record<string, unknown>)[col];
                return (
                  <td key={col} style={tdStyles}>
                    {val === null ? (
                      <span style={nullValueStyles}>NULL</span>
                    ) : typeof val === "object" ? (
                      <span style={jsonValueStyles}>{JSON.stringify(val)}</span>
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const C = {
  bg: "#0e1015",
  bgPanel: "#161921",
  bgCard: "#1c2030",
  bgInput: "#111318",
  border: "#2a2f3e",
  borderLight: "#343a4f",
  text: "#e2e8f0",
  textMuted: "#6b7280",
  textDim: "#9ca3af",
  teal: "#2dd4bf",
  tealDim: "rgba(45,212,191,0.12)",
  tealGlow: "rgba(45,212,191,0.06)",
  error: "#f87171",
  errorBg: "rgba(248,113,113,0.08)",
  errorBorder: "rgba(248,113,113,0.25)",
  success: "#34d399",
  successBg: "rgba(52,211,153,0.08)",
  amber: "#fbbf24",
};

const floatingRootStyles: CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: 9998,
};

const triggerButtonStyles: CSSProperties = {
  position: "absolute",
  right: "16px",
  bottom: "16px",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "0.3rem 0.45rem",
  background: C.bgPanel,
  color: C.text,
  boxShadow: `0 0 0 1px ${C.border}, 0 4px 16px rgba(0,0,0,0.5)`,
  cursor: "pointer",
  pointerEvents: "auto",
};

const triggerIconStyles: CSSProperties = {
  color: C.teal,
  fontSize: "0.9rem",
  lineHeight: 1,
};

const triggerCountStyles: CSSProperties = {
  minWidth: "1.1rem",
  borderRadius: "4px",
  padding: "0.05rem 0.25rem",
  backgroundColor: C.tealDim,
  color: C.teal,
  fontSize: "0.65rem",
  fontWeight: 700,
  textAlign: "center",
  fontFamily: "ui-monospace, monospace",
};

const overlayStyles: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1.5rem",
  backgroundColor: "rgba(0,0,0,0.72)",
  backdropFilter: "blur(8px)",
};

const dialogStyles: CSSProperties = {
  width: "min(72rem, 100%)",
  height: "min(90vh, 860px)",
  display: "flex",
  flexDirection: "column",
  border: `1px solid ${C.border}`,
  borderRadius: "16px",
  background: C.bg,
  boxShadow: `0 0 0 1px ${C.border}, 0 40px 80px rgba(0,0,0,0.8), 0 0 60px rgba(45,212,191,0.04)`,
  overflow: "hidden",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  color: C.text,
  fontSize: "0.88rem",
};

const headerStyles: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  padding: "0.85rem 1.1rem",
  borderBottom: `1px solid ${C.border}`,
  background: C.bgPanel,
  flexShrink: 0,
};

const headerLeftStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};

const headerLogoStyles: CSSProperties = {
  fontSize: "1.3rem",
  color: C.teal,
  lineHeight: 1,
};

const eyebrowStyles: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 600,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: C.textMuted,
  fontFamily: "ui-monospace, monospace",
};

const titleStyles: CSSProperties = {
  margin: "0.05rem 0 0",
  fontSize: "0.95rem",
  fontWeight: 700,
  color: C.text,
  letterSpacing: "-0.01em",
};

const headerRightStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

const instancePickerLabelStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const instancePickerTextStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: C.textMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const instancePickerSelectStyles: CSSProperties = {
  borderRadius: "7px",
  border: `1px solid ${C.border}`,
  padding: "0.35rem 0.6rem",
  backgroundColor: C.bgCard,
  color: C.text,
  fontSize: "0.82rem",
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};

const instanceCountBadgeStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: C.teal,
  backgroundColor: C.tealDim,
  borderRadius: "5px",
  padding: "0.2rem 0.5rem",
  fontFamily: "ui-monospace, monospace",
};

const closeButtonStyles: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: "7px",
  width: "28px",
  height: "28px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "transparent",
  color: C.textMuted,
  fontSize: "0.82rem",
  fontWeight: 600,
  cursor: "pointer",
};

const emptyStateStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "4rem 2rem",
  gap: "0.75rem",
  flex: 1,
};

const emptyStateIconStyles: CSSProperties = {
  fontSize: "2.5rem",
  color: C.textMuted,
  opacity: 0.4,
};

const emptyStateTextStyles: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: C.textDim,
};

const emptyStateSubtextStyles: CSSProperties = {
  margin: 0,
  fontSize: "0.82rem",
  color: C.textMuted,
  textAlign: "center",
};

const inlineCodeStyles: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  backgroundColor: C.bgCard,
  border: `1px solid ${C.border}`,
  borderRadius: "4px",
  padding: "0.1em 0.4em",
  fontSize: "0.88em",
  color: C.teal,
};

const contentLayoutStyles: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px minmax(0, 1fr)",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const sidebarStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0",
  padding: "0.75rem",
  borderRight: `1px solid ${C.border}`,
  background: C.bgPanel,
  overflowY: "auto",
};

const navStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  marginBottom: "1rem",
};

const navIconStyles: CSSProperties = {
  fontSize: "0.7rem",
  opacity: 0.7,
};

const sidebarInfoStyles: CSSProperties = {
  marginTop: "auto",
  padding: "0.75rem",
  borderRadius: "8px",
  background: C.bgCard,
  border: `1px solid ${C.border}`,
};

const sidebarInfoLabelStyles: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.textMuted,
  marginBottom: "0.3rem",
};

const sidebarInfoValueStyles: CSSProperties = {
  fontSize: "0.88rem",
  fontWeight: 600,
  color: C.text,
  wordBreak: "break-word",
  fontFamily: "ui-monospace, monospace",
};

const sidebarInfoSubStyles: CSSProperties = {
  fontSize: "0.72rem",
  color: C.textMuted,
  fontFamily: "ui-monospace, monospace",
  marginTop: "0.25rem",
};

const mainPaneStyles: CSSProperties = {
  minWidth: 0,
  overflowY: "auto",
  padding: "1rem",
};

// ─── Overview tab styles ───────────────────────────────────────────────────────

const overviewLayoutStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1.25rem",
};

const overviewCardsRowStyles: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.75rem",
};

const overviewCardStyles: CSSProperties = {
  padding: "0.9rem 1rem",
  borderRadius: "10px",
  border: `1px solid ${C.border}`,
  background: C.bgCard,
};

const overviewCardLabelStyles: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.textMuted,
  marginBottom: "0.4rem",
};

const overviewCardValueStyles: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  color: C.text,
  wordBreak: "break-word",
};

const overviewSectionStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const overviewSectionTitleStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.textMuted,
};

const overviewSectionHeaderStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const overviewRefreshButtonStyles: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: "7px",
  padding: "0.35rem 0.7rem",
  backgroundColor: "transparent",
  color: C.textDim,
  fontSize: "0.78rem",
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
  flexShrink: 0,
};

const overviewAccumulatorValueStyles: CSSProperties = {
  padding: "0.75rem",
  borderRadius: "8px",
  border: `1px solid ${C.border}`,
  background: C.bgCard,
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.78rem",
  color: C.text,
  lineHeight: 1.5,
  wordBreak: "break-all",
};

const overviewAccumulatorEmptyStyles: CSSProperties = {
  color: C.textMuted,
  fontStyle: "italic",
};

const overviewAccumulatorErrorStyles: CSSProperties = {
  color: C.error,
};

const overviewEmptyStyles: CSSProperties = {
  fontSize: "0.82rem",
  color: C.textMuted,
  fontStyle: "italic",
};

const crdtTableListStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const crdtTableRowStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.5rem 0.75rem",
  borderRadius: "7px",
  background: C.bgCard,
  border: `1px solid ${C.border}`,
};

const crdtTableIconStyles: CSSProperties = {
  color: C.teal,
  fontSize: "0.72rem",
};

const crdtTableNameStyles: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: "0.85rem",
  color: C.text,
};

const permissionRowStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  fontSize: "0.82rem",
  color: C.textDim,
};

const permissionIconStyles: CSSProperties = {
  color: C.success,
  fontWeight: 700,
  fontSize: "0.85rem",
  lineHeight: 1,
};

const permissionTextStyles: CSSProperties = {
  color: C.textDim,
};

const dangerZoneStyles: CSSProperties = {
  marginTop: "auto",
  borderRadius: "10px",
  border: `1px solid ${C.errorBorder}`,
  padding: "0.75rem 1rem",
  background: C.errorBg,
};

const dangerZoneTitleStyles: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.error,
  marginBottom: "0.5rem",
};

const dangerZoneRowStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};

const dangerZoneDescStyles: CSSProperties = {
  fontSize: "0.75rem",
  color: C.textMuted,
  lineHeight: 1.5,
};

const dangerZoneActionsStyles: CSSProperties = {
  display: "flex",
  gap: "0.4rem",
  flexShrink: 0,
};

const resetButtonStyles: CSSProperties = {
  flexShrink: 0,
  border: `1px solid ${C.errorBorder}`,
  borderRadius: "7px",
  padding: "0.35rem 0.75rem",
  backgroundColor: "transparent",
  color: C.error,
  fontSize: "0.78rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const resetCancelButtonStyles: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: "7px",
  padding: "0.35rem 0.65rem",
  backgroundColor: "transparent",
  color: C.textDim,
  fontSize: "0.78rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const resetConfirmButtonStyles: CSSProperties = {
  border: "none",
  borderRadius: "7px",
  padding: "0.35rem 0.75rem",
  backgroundColor: C.error,
  color: "#0e1015",
  fontSize: "0.78rem",
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// ─── Query runner tab styles ───────────────────────────────────────────────────

const queryRunnerLayoutStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  height: "100%",
};

const queryToolbarStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const targetToggleStyles: CSSProperties = {
  display: "flex",
  gap: "0",
  borderRadius: "8px",
  border: `1px solid ${C.border}`,
  overflow: "hidden",
  background: C.bgCard,
};

const queryToolbarRightStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

const noInstanceWarningStyles: CSSProperties = {
  fontSize: "0.75rem",
  color: C.amber,
  fontWeight: 500,
};

const shortcutHintStyles: CSSProperties = {
  fontSize: "0.72rem",
  color: C.textMuted,
  fontFamily: "ui-monospace, monospace",
  padding: "0.2rem 0.5rem",
  borderRadius: "5px",
  border: `1px solid ${C.border}`,
  background: C.bgCard,
};

const editorWrapperStyles: CSSProperties = {
  borderRadius: "10px",
  border: `1px solid ${C.border}`,
  overflow: "hidden",
  background: C.bgInput,
};

const textareaStyles: CSSProperties = {
  width: "100%",
  minHeight: "9rem",
  resize: "vertical",
  border: "none",
  padding: "0.85rem 1rem",
  backgroundColor: "transparent",
  color: C.text,
  fontSize: "0.875rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  lineHeight: 1.6,
  outline: "none",
  boxSizing: "border-box",
};

const helperTextStyles: CSSProperties = {
  fontSize: "0.75rem",
  lineHeight: 1.5,
  color: C.textMuted,
};

const resultPanelStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
  borderRadius: "10px",
  border: `1px solid ${C.border}`,
  overflow: "hidden",
  background: C.bgPanel,
};

const errorPanelStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
  padding: "0.85rem 1rem",
  borderRadius: "10px",
  border: `1px solid ${C.errorBorder}`,
  background: C.errorBg,
};

const resultHeaderStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.6rem 0.85rem",
  borderBottom: `1px solid ${C.border}`,
  background: C.bgCard,
};

const successBadgeStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  color: C.success,
  backgroundColor: C.successBg,
  borderRadius: "5px",
  padding: "0.15rem 0.5rem",
  fontFamily: "ui-monospace, monospace",
};

const errorBadgeStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  color: C.error,
  backgroundColor: C.errorBg,
  borderRadius: "5px",
  padding: "0.15rem 0.5rem",
  fontFamily: "ui-monospace, monospace",
};

const resultMetaStyles: CSSProperties = {
  fontSize: "0.72rem",
  color: C.textMuted,
  fontFamily: "ui-monospace, monospace",
};

const resultEmptyStyles: CSSProperties = {
  padding: "1.5rem",
  fontSize: "0.82rem",
  color: C.textMuted,
  fontStyle: "italic",
  textAlign: "center",
};

const resultRawStyles: CSSProperties = {
  margin: 0,
  padding: "0.85rem 1rem",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: "0.8rem",
  lineHeight: 1.5,
  color: C.text,
  fontFamily: "ui-monospace, monospace",
};

const errorMessageStyles: CSSProperties = {
  margin: 0,
  fontSize: "0.82rem",
  lineHeight: 1.6,
  color: C.error,
  fontFamily: "ui-monospace, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const tableWrapperStyles: CSSProperties = {
  overflowX: "auto",
  maxHeight: "320px",
  overflowY: "auto",
};

const tableStyles: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.8rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const thStyles: CSSProperties = {
  padding: "0.5rem 0.85rem",
  textAlign: "left",
  fontWeight: 600,
  fontSize: "0.7rem",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: C.textMuted,
  borderBottom: `1px solid ${C.border}`,
  borderRight: `1px solid ${C.border}`,
  background: C.bgCard,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
};

const thRowNumStyles: CSSProperties = {
  ...thStyles,
  color: C.textMuted,
  opacity: 0.5,
  width: "2.5rem",
  textAlign: "right",
};

const trStyles: CSSProperties = {
  background: "transparent",
};

const trAltStyles: CSSProperties = {
  background: C.tealGlow,
};

const tdStyles: CSSProperties = {
  padding: "0.45rem 0.85rem",
  borderBottom: `1px solid ${C.border}`,
  borderRight: `1px solid ${C.border}`,
  color: C.text,
  whiteSpace: "nowrap",
  maxWidth: "300px",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tdRowNumStyles: CSSProperties = {
  ...tdStyles,
  color: C.textMuted,
  opacity: 0.5,
  textAlign: "right",
  userSelect: "none",
};

const nullValueStyles: CSSProperties = {
  color: C.textMuted,
  fontStyle: "italic",
  opacity: 0.6,
};

const jsonValueStyles: CSSProperties = {
  color: C.textDim,
};

function getTabButtonStyles(isActive: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    width: "100%",
    border: "none",
    borderRadius: "7px",
    padding: "0.6rem 0.75rem",
    background: isActive ? C.tealDim : "transparent",
    color: isActive ? C.teal : C.textDim,
    fontSize: "0.82rem",
    fontWeight: isActive ? 700 : 500,
    textAlign: "left",
    cursor: "pointer",
    transition: "background 0.15s",
    borderLeft: isActive ? `2px solid ${C.teal}` : "2px solid transparent",
  };
}

function getTargetButtonStyles(isActive: boolean): CSSProperties {
  return {
    border: "none",
    borderRight: `1px solid ${C.border}`,
    padding: "0.45rem 0.85rem",
    background: isActive ? C.tealDim : "transparent",
    color: isActive ? C.teal : C.textMuted,
    fontSize: "0.78rem",
    fontWeight: isActive ? 700 : 500,
    cursor: "pointer",
    fontFamily: "ui-monospace, monospace",
    transition: "background 0.1s",
    whiteSpace: "nowrap",
  };
}

function runButtonStyles(enabled: boolean, running: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.4rem",
    border: "none",
    borderRadius: "7px",
    padding: "0.45rem 0.9rem",
    background: enabled ? C.teal : C.bgCard,
    color: enabled ? "#0e1015" : C.textMuted,
    fontSize: "0.82rem",
    fontWeight: 700,
    fontFamily: "ui-monospace, monospace",
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: running ? 0.75 : 1,
    transition: "background 0.15s",
    whiteSpace: "nowrap",
  };
}

const runningDotStyles: CSSProperties = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  backgroundColor: "currentColor",
  animation: "pulse 1s infinite",
};

// ─── Schema tab styles ────────────────────────────────────────────────────────

const schemaLayoutStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1.5rem",
};

const schemaSectionStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
};

const schemaSectionHeaderStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

const schemaSectionTitleStyles: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.textMuted,
};

const schemaBadgeStyles: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  color: C.teal,
  backgroundColor: C.tealDim,
  borderRadius: "4px",
  padding: "0.1rem 0.4rem",
  fontFamily: "ui-monospace, monospace",
};

const schemaMigrationsMetaStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginLeft: "auto",
};

const schemaVersionChipStyles: CSSProperties = {
  fontSize: "0.68rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
  backgroundColor: C.bgCard,
  border: `1px solid ${C.border}`,
  borderRadius: "4px",
  padding: "0.1rem 0.5rem",
};

const schemaTableGridStyles: CSSProperties = {
  borderRadius: "10px",
  border: `1px solid ${C.border}`,
  overflow: "hidden",
};

const schemaTableHeaderRowStyles: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 90px",
  gap: 0,
  backgroundColor: C.bgCard,
  borderBottom: `1px solid ${C.border}`,
};

const schemaColHeaderStyles: CSSProperties = {
  padding: "0.5rem 0.85rem",
  fontSize: "0.68rem",
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: C.textMuted,
  borderRight: `1px solid ${C.border}`,
};

const schemaTableRowStyles: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 90px",
  gap: 0,
  borderBottom: `1px solid ${C.border}`,
};

const schemaTableNameStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.6rem 0.85rem",
  fontSize: "0.82rem",
  fontFamily: "ui-monospace, monospace",
  color: C.text,
  borderRight: `1px solid ${C.border}`,
};

const schemaTableIconStyles: CSSProperties = {
  color: C.teal,
  fontSize: "0.68rem",
  opacity: 0.8,
};

const schemaCrdtNameStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0.6rem 0.85rem",
  fontSize: "0.82rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textDim,
  borderRight: `1px solid ${C.border}`,
};

const schemaStatusCellStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.6rem 0.5rem",
};

const schemaActiveTagStyles: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  color: C.success,
  backgroundColor: C.successBg,
  borderRadius: "4px",
  padding: "0.15rem 0.45rem",
  fontFamily: "ui-monospace, monospace",
};

const schemaEmptyStyles: CSSProperties = {
  fontSize: "0.82rem",
  color: C.textMuted,
  fontStyle: "italic",
};

const migrationListStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

function getMigrationRowStyles(applied: boolean): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "3.5rem 1fr 70px",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.55rem 0.85rem",
    borderRadius: "8px",
    background: applied ? C.bgCard : "transparent",
    border: `1px solid ${applied ? C.border : C.borderLight}`,
    opacity: applied ? 1 : 0.55,
  };
}

const migrationVersionStyles: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 700,
  fontFamily: "ui-monospace, monospace",
  color: C.textDim,
};

const migrationBarTrackStyles: CSSProperties = {
  height: "4px",
  borderRadius: "2px",
  backgroundColor: C.border,
  overflow: "hidden",
};

function getMigrationBarFillStyles(applied: boolean): CSSProperties {
  return {
    height: "100%",
    width: applied ? "100%" : "0%",
    borderRadius: "2px",
    backgroundColor: C.teal,
    transition: "width 0.3s ease",
  };
}

function getMigrationTagStyles(applied: boolean, isCurrent: boolean): CSSProperties {
  if (isCurrent) {
    return {
      fontSize: "0.68rem",
      fontWeight: 700,
      color: C.teal,
      backgroundColor: C.tealDim,
      borderRadius: "4px",
      padding: "0.15rem 0.45rem",
      fontFamily: "ui-monospace, monospace",
      textAlign: "center",
    };
  }
  if (applied) {
    return {
      fontSize: "0.68rem",
      fontWeight: 600,
      color: C.success,
      backgroundColor: C.successBg,
      borderRadius: "4px",
      padding: "0.15rem 0.45rem",
      fontFamily: "ui-monospace, monospace",
      textAlign: "center",
    };
  }
  return {
    fontSize: "0.68rem",
    fontWeight: 600,
    color: C.amber,
    backgroundColor: "rgba(251,191,36,0.08)",
    borderRadius: "4px",
    padding: "0.15rem 0.45rem",
    fontFamily: "ui-monospace, monospace",
    textAlign: "center",
  };
}

// ─── Event log tab styles ─────────────────────────────────────────────────────

const eventLogLayoutStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  height: "100%",
};

const eventLogToolbarStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  flexShrink: 0,
};

const eventLogFilterSelectStyles: CSSProperties = {
  borderRadius: "7px",
  border: `1px solid ${C.border}`,
  padding: "0.35rem 0.6rem",
  backgroundColor: C.bgCard,
  color: C.text,
  fontSize: "0.78rem",
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};

const eventLogRefreshButtonStyles: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: "7px",
  padding: "0.35rem 0.7rem",
  backgroundColor: "transparent",
  color: C.textDim,
  fontSize: "0.78rem",
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};

const eventLogCountStyles: CSSProperties = {
  marginLeft: "auto",
  fontSize: "0.72rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
};

const eventLogEmptyStyles: CSSProperties = {
  padding: "2rem",
  textAlign: "center",
  fontSize: "0.82rem",
  color: C.textMuted,
  fontStyle: "italic",
};

const eventLogListStyles: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  overflowY: "auto",
  flex: 1,
};

function getEventRowStyles(isExpanded: boolean): CSSProperties {
  return {
    borderRadius: "8px",
    border: `1px solid ${isExpanded ? `${C.teal}40` : C.border}`,
    background: isExpanded ? C.tealGlow : C.bgCard,
    overflow: "hidden",
    flexShrink: 0,
  };
}

const eventRowHeaderStyles: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  width: "100%",
  padding: "0.5rem 0.75rem",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  flexWrap: "wrap",
};

const eventSyncIdStyles: CSSProperties = {
  fontSize: "0.7rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
  minWidth: "3.5rem",
};

const eventDatasetStyles: CSSProperties = {
  fontSize: "0.8rem",
  fontFamily: "ui-monospace, monospace",
  color: C.text,
  fontWeight: 600,
};

const eventItemIdStyles: CSSProperties = {
  fontSize: "0.75rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const eventTimestampStyles: CSSProperties = {
  fontSize: "0.7rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
  marginLeft: "auto",
};

const eventChevronStyles: CSSProperties = {
  fontSize: "0.6rem",
  color: C.textMuted,
  marginLeft: "0.25rem",
};

const eventPayloadStyles: CSSProperties = {
  borderTop: `1px solid ${C.border}`,
  padding: "0.6rem 0.75rem",
};

const eventPayloadMetaStyles: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  marginBottom: "0.5rem",
};

const eventMetaItemStyles: CSSProperties = {
  fontSize: "0.68rem",
  fontFamily: "ui-monospace, monospace",
  color: C.textMuted,
};

const eventPayloadPreStyles: CSSProperties = {
  margin: 0,
  fontSize: "0.78rem",
  fontFamily: "ui-monospace, monospace",
  color: C.text,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const loadMoreButtonStyles: CSSProperties = {
  width: "100%",
  border: `1px solid ${C.border}`,
  borderRadius: "8px",
  padding: "0.6rem",
  backgroundColor: "transparent",
  color: C.textDim,
  fontSize: "0.78rem",
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
  flexShrink: 0,
};

// Event type badges
const eventTypeBadgeBase: CSSProperties = {
  fontSize: "0.65rem",
  fontWeight: 700,
  borderRadius: "4px",
  padding: "0.1rem 0.4rem",
  fontFamily: "ui-monospace, monospace",
  whiteSpace: "nowrap",
};

const eventTypeCreateStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.teal,
  backgroundColor: C.tealDim,
};

const eventTypeUpdateStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: "#a78bfa",
  backgroundColor: "rgba(167,139,250,0.12)",
};

// Origin badges
const eventOriginOwnStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.success,
  backgroundColor: C.successBg,
};

const eventOriginRemoteStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.amber,
  backgroundColor: "rgba(251,191,36,0.1)",
};

const eventOriginLocalStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.textDim,
  backgroundColor: C.bgCard,
  border: `1px solid ${C.border}`,
};

// Status badges
const eventStatusAppliedStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.success,
  backgroundColor: C.successBg,
};

const eventStatusPendingStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.amber,
  backgroundColor: "rgba(251,191,36,0.1)",
};

const eventStatusFailedStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.error,
  backgroundColor: C.errorBg,
};

const eventStatusSkippedStyles: CSSProperties = {
  ...eventTypeBadgeBase,
  color: C.textMuted,
  backgroundColor: C.bgCard,
};
