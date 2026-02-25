# Pending Issues

## Critical

### ~~2. No clock drift guard in HLC~~ ✅ Fixed

`mergeHLC` now checks incoming timestamps against `wallClock + maxDrift` (default 6 hours). Far-future timestamps are silently ignored with a `console.warn`, preventing clock poisoning while still applying the event data normally.

### ~~4. Cloudflare adapter: unquoted SQL identifiers~~ ✅ Fixed

`updateItem` in `durable-object-adapter.ts` now uses `quoteId()` for both table and column names, matching the core package fix. `quoteId` was also exported from `@sqlite-sync/core`'s public API.

## High

### 6. `excludeNodeId` filter is a no-op

`db-worker.ts:178`

```ts
pullEvents: (request) => {
  return crdtStorage.getEventsBatch({
    excludeOrigin: request.excludeNodeId, // tab UUID vs "local"/"own"/"remote"
  });
},
```

The tab passes its UUID as `excludeNodeId`, which is compared against the `origin` column (values: `"local"`, `"own"`, `"remote"`). It will never match, so the tab always re-pulls and re-applies its own events from the worker. The LWW logic prevents data corruption, but every event is processed twice — wasting bandwidth and potentially causing UI flicker in reactive queries.

### 8. No server-side event deduplication

`durable-object-adapter.ts:300-313`

`enqueueLocalEvents` unconditionally inserts all received events. Client retries (3 attempts via `retryAsPromised`) duplicate events in the log. Each duplicate gets a new `sync_id` and is broadcast to all connected clients. The event log grows without bound with duplicates.

### 9. Server HLC node ID hardcoded to `"root"`

`durable-object-adapter.ts:157`

All Durable Object instances use `nodeId = "root"`. For LWW conflict resolution, the node ID is the final tiebreaker. Two server shards processing events simultaneously for the same item at the same timestamp+counter cannot be distinguished, causing non-deterministic merge behavior.

### 11. No worker crash detection or recovery

`db-worker-client.ts:37-133`

If the worker is killed (OOM, browser kill), there is no `worker.onerror` handler. All pending RPC calls hang for 30 seconds before timing out. The tab enters an unrecoverable state — no retry logic exists, and `createSyncedDb` must be called again externally.

### 13. No validation that `tombstone`/`id` columns exist

`make-crdt-table.ts:25,67`

The CRDT view assumes `tombstone` and `id` columns exist. If a user defines a table without them, the view creation succeeds silently (SQLite doesn't validate views at creation), but queries fail at runtime. The delete trigger also assumes `old.id` — a missing `id` column produces `NULL` item IDs in CRDT events.

## Medium

### 16. React `useDbQuery` leaks old live query subscriptions

`packages/react/src/react.tsx:39-44`

When `sql` changes, `useMemo` creates a new `liveQuery` without disposing the old one. While React's `useSyncExternalStore` cleanup handles unsubscription, there's a TOCTOU window where the old subscription fires `onDataChange` against a stale React callback. The `liveQueryStatements` BoundMap also retains old prepared statements until evicted at 100 entries.

### 19. Skipped events don't advance HLC

`crdt-storage.ts:177-182`

When an event is skipped (table dropped by migration), the function returns early before `storage.hlc.mergeHLC`. If the skipped event's timestamp is ahead of local clock, the local HLC won't advance, potentially causing future timestamps to appear before the skipped event's timestamp in LWW comparisons.

## Low

### 20. `hasMore` off-by-one

`crdt-storage.ts:162` — `hasMore: events.length === limit` causes one unnecessary extra fetch when the batch size exactly matches the limit.

### 22. `ensureSingletonExecution` re-executes with stale arguments

`utils.ts:52-58` — The re-execution path uses `...args` from the first call, not the call that triggered `shouldReExecute = true`. Currently harmless (all callers are zero-arg), but a latent bug.

### 23. `migrateEvent` error message references wrong variable

`migrator.ts:288` — Says "Event schema version" but should say "Target schema version."

### 27. `mapData` excluded from `useMemo` deps in React hook

`packages/react/src/react.tsx:62-65` — Inline arrow functions as `mapData` produce stale closures.

### 28. `resolseQuery` typo

`packages/react/src/react.tsx:89` — Should be `resolveQuery`.
