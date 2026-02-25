# Pending Issues

## Critical

### ~~2. No clock drift guard in HLC~~ ✅ Fixed

`mergeHLC` now checks incoming timestamps against `wallClock + maxDrift` (default 6 hours). Far-future timestamps are silently ignored with a `console.warn`, preventing clock poisoning while still applying the event data normally.

### ~~4. Cloudflare adapter: unquoted SQL identifiers~~ ✅ Fixed

`updateItem` in `durable-object-adapter.ts` now uses `quoteId()` for both table and column names, matching the core package fix. `quoteId` was also exported from `@sqlite-sync/core`'s public API.

## High

### ~~6. `excludeNodeId` filter is a no-op~~ ✅ Fixed

A new `source_node_id` column was added to CRDT events, tracked via system migrations (`ALTER TABLE ... ADD COLUMN`). Each node now stamps its identity on events it generates. The `excludeNodeId` filter queries `source_node_id` instead of `origin`, so tab UUIDs are correctly matched and filtered. The old `excludeOrigin` filter remains for filtering by origin category (e.g. excluding `"remote"` events when pushing to server).

### ~~8. No server-side event deduplication~~ ✅ Fixed

A unique index on `(timestamp, source_node_id)` now prevents duplicate events at the database level. The Durable Object adapter uses `ON CONFLICT DO NOTHING` for idempotent inserts. A data migration (system migration version 2) cleans up any pre-existing duplicates. System migrations were made extensible so downstream packages can add their own.

### ~~9. Server HLC node ID hardcoded to `"root"`~~ ✅ Fixed

Each Durable Object now uses its own ID (`ctx.id.toString()`) as the HLC node ID, ensuring unique tiebreakers for LWW conflict resolution across different DO instances.

### ~~13. No validation that `tombstone`/`id` columns exist~~ ✅ Fixed

`makeCrdtTable` now validates that `id` and `tombstone` columns are present in the schema at call time, throwing a descriptive error if either is missing. This prevents silent runtime failures from invalid CRDT table definitions.

## Medium

### ~~16. React `useDbQuery` leaks old live query subscriptions~~ ✅ Not a bug

Verified as invalid. `useSyncExternalStore` correctly handles subscription cleanup via the unsubscribe function returned by `subscribe()`. After unsubscribe, `subscriber` is set to `null`, so even if a debounced callback fires late, `subscriber?.()` is a no-op. The `liveQueryStatements` BoundMap is an intentional bounded LRU cache (max 100 entries) with `finalize()` on eviction — by design, not a leak.

### ~~19. Skipped events don't advance HLC~~ ✅ Fixed

The HLC is now advanced (`mergeHLC`) even when an event is skipped due to a dropped table, preventing timestamp regression in subsequent LWW comparisons.

## Low

### ~~20. `hasMore` off-by-one~~ ✅ Fixed

`crdt-storage.ts` now uses the fetch-N+1 pattern: requests `limit + 1` rows and checks `events.length > limit` to definitively determine whether more events exist. The extra sentinel row is popped before returning. This eliminates false-positive `hasMore` signals that caused unnecessary extra fetches in the processing loop and redundant pull requests from clients.

### ~~22. `ensureSingletonExecution` re-executes with stale arguments~~ ✅ Verified

`utils.ts:52-58` — The re-execution path uses `...args` from the first call, not the call that triggered `shouldReExecute = true`. `goOffline` is the one caller that passes args (`reason: OfflineReason`), but an early-return guard (`remoteState.type !== "online"`) makes the re-execution a no-op in practice, so the stale reason is never stored.

### ~~23. `migrateEvent` error message references wrong variable~~ ✅ Fixed

`migrator.ts:289` — Error message now correctly references `targetVersion` instead of `event.schema_version`, matching the condition being checked.

### 27. `mapData` excluded from `useMemo` deps in React hook

`packages/react/src/react.tsx:62-65` — Inline arrow functions as `mapData` produce stale closures.

### ~~28. `resolseQuery` typo~~ ✅ Fixed

`packages/react/src/react.tsx:89` — Renamed to `resolveQuery`.
