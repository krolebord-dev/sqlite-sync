# Core Logic Audit

Thorough analysis of the sqlite-sync core architecture. False positives have been verified and removed — only confirmed issues remain.

## CRITICAL — Causes failures in normal operation

### ~~1. Worker RPC: Unhandled promise rejections + no timeout~~ ✅ RESOLVED

**Files:** `db-worker.ts`, `db-worker-client.ts`

**Fixed in:**
- `d273bc3` — Added `.catch(sendError)` to the async RPC branch in `db-worker.ts`, so rejected promises now send an error response back to the client.
- Added 30s request timeout to `queryWorker` and 15s init timeout to `awaitWorkerState` in `db-worker-client.ts`, using the existing `createDeferredPromise({ timeout, onTimeout })` infrastructure. Timed-out requests clean up their `workerRequestsMap` entry, preventing memory leaks.

---

## HIGH — Correctness issues causing data inconsistency or sync failures

### ~~2. Pull notification coalescing is broken~~ ✅ RESOLVED

**File:** `crdt-sync-remote-source.ts:98-103, 164-197`

**Fixed in:**
- `8208341` — `onEventsAvailable` now passes `newSyncId` through as `remoteSyncId` to `pullEvents()`. The coalescing logic was refactored: an early return rejects `remoteSyncId <= pullSyncId.current`, so `requestedPullSyncId` can never be `0`, making the truthiness check in `.finally()` safe.

---

### ~~3. Update events for non-existent items are permanently lost~~ ❌ FALSE POSITIVE

**File:** `apply-crdt-event.ts:202-204`

**Why this is unreachable:** The sync model is master-replica at every level (tabs↔worker, worker↔remote). A peer can only generate an `item-updated` event if the item exists in its local database. For the item to exist locally, either:
- The peer created it itself (and pushes the `item-created` first or in the same batch), or
- The peer received the `item-created` via sync (meaning it's already on the server with a lower `sync_id`).

In both cases, the server's `sync_id` ordering naturally preserves the causal dependency: any pulling peer receives `item-created` before `item-updated`. The described scenario of "network reordering or batched sync" causing out-of-order delivery does not apply — events are always pulled in `sync_id` order, and the creation event always has a lower `sync_id` than any update from a peer that received it.

The `if (!meta) throw` remains a reasonable defensive check, but the scenario it guards against is not reachable under normal operation.

---

### ~~4. Schema version mismatch causes permanent offline~~ ❌ FALSE POSITIVE

**File:** `crdt-sync-remote-source.ts:228-231`

**Why this is not an issue:** The client correctly refuses to apply events it doesn't understand. Recovery is a standard page reload, which downloads the new client code with the matching schema version. This is expected behavior for web apps during rolling deployments — not a bug.

A UX improvement (surfacing the mismatch to the user) is tracked in `improvements.md`.

---

### ~~5. Statement cache can finalize in-use prepared statements~~ ❌ FALSE POSITIVE

**File:** `sqlite-reactive-db.ts:67-72` (via BoundMap)

Not a real issue. `fetchRows` does a synchronous `.get()` then `.execute()` with no yield point — JS is single-threaded, so no interleaving can occur. If a statement was previously evicted, `.get()` returns `undefined` and the `if (!statement)` branch re-prepares it. No statement reference is held across async boundaries.

---

## MEDIUM — Design issues worth addressing

### ~~6. Delete (tombstone) and concurrent update ordering~~ ❌ FALSE POSITIVE

**Files:** `make-crdt-table.ts:158-164`, `apply-crdt-event.ts:159-167`

Not an issue with the current CRDT design. Per-field LWW is working as intended — the tombstone field wins independently of data fields. Data field overwrites on a tombstoned item have no observable effect since tombstoned items are filtered from queries. Un-deletion is not a supported operation.

---

### ~~7. HLC deserialization has no input validation~~ ✅ RESOLVED

**File:** `hlc.ts:58-76`

**Fixed:** `deserializeHLC` now validates segment count (≥3 colon-separated parts) and checks `Number.isNaN()` on both parsed timestamp and counter. Malformed input throws a descriptive error instead of silently producing NaN. The call site in `crdt-storage.ts:195` already wraps this in a try/catch, so a single bad event is marked `"failed"` without crashing the sync loop.

---

### ~~8. No dispose/cleanup mechanism for SyncedDb~~ ✅ RESOLVED

**File:** `sync-db.ts`

**Fixed in:**
- `4fcdbe1` — Added `dispose()` across all layers: `TypedBroadcastChannel.close()`, worker client dispose (rejects pending RPCs), `SQLiteReactiveDb.dispose()` (finalizes statements, closes WASM DB), `CrdtSyncRemoteSource.dispose()` (disconnects remote), and top-level `SyncedDb.dispose()` orchestrating teardown in order. Worker self-terminates via Web Locks: each SyncedDb holds a shared lock, worker polls `navigator.locks.query()` and gracefully shuts down when no clients remain.

---

### 9. No unique constraint conflict resolution — KNOWN LIMITATION

**File:** `apply-crdt-event.ts:192`

Duplicate `id` creation is already handled: `applyItemCreated` checks the CRDT update log (`meta`) and falls through to LWW merge if the item exists. However, non-PK unique constraints (e.g., a `UNIQUE` column like `email`) have no conflict resolution. Two nodes can create items with different `id`s but the same unique column value, causing a SQLite constraint violation on replication. The CRDT layer only tracks conflicts by `(item_id, dataset)` and has no knowledge of table-level unique constraints.

This is a known architectural limitation of per-field LWW CRDTs. Mitigation: avoid unique constraints on CRDT tables and enforce uniqueness at the application layer instead.

---

### 10. SQL identifiers not quoted

**Files:** `make-crdt-table.ts:22-24`, `apply-crdt-event.ts:92`

Table and column names are string-interpolated without identifier quoting:

```typescript
`create view ${crdtTableName} as select * from ${baseTableName}`
`update ${opts.dataset} set ${keys.map((key) => `${key} = ?`).join(",")}`
```

These come from developer-controlled code (not user input), so injection risk is low. But names containing spaces, hyphens, or SQLite keywords will break. Should use double-quote escaping for robustness.

---

### ~~11. HLC counter overflow~~ ✅ RESOLVED

**File:** `hlc.ts:38`

**Fixed:** Added `MAX_COUNTER` constant (`36^5 - 1 = 60,466,175`) and overflow checks after every counter increment in both `getNextHLC()` and `mergeHLC()`. Overflow throws a descriptive error instead of silently corrupting serialized HLC ordering.

---

## Summary

| #  | Issue                                          | Severity     | Impact                                    |
|----|------------------------------------------------|--------------|-------------------------------------------|
| 1  | ~~Worker RPC unhandled rejections + no timeout~~ | ✅ RESOLVED  | ~~Tab hangs forever, memory leak~~        |
| 2  | ~~Pull notification coalescing broken~~         | ✅ RESOLVED  | ~~Missed events during active sync~~      |
| 3  | ~~Out-of-order update events permanently lost~~ | ❌ FALSE POSITIVE | ~~Data loss on concurrent remote writes~~ |
| 4  | ~~Schema version mismatch → permanent offline~~ | ❌ FALSE POSITIVE | ~~Blocks rolling deployments~~            |
| 5  | ~~Statement cache finalizes active statements~~ | ❌ FALSE POSITIVE | Statements are re-prepared on cache miss |
| 6  | ~~Tombstone + concurrent update semantics~~     | ❌ FALSE POSITIVE | Per-field LWW working as designed        |
| 7  | ~~HLC deserialization no validation~~           | ✅ RESOLVED  | ~~Clock corruption from malformed input~~ |
| 8  | ~~No SyncedDb disposal~~                       | ✅ RESOLVED  | ~~Memory leaks in SPAs~~                  |
| 9  | No unique constraint conflict resolution        | KNOWN LIMITATION | Replication failure on non-PK unique collision |
| 10 | Unquoted SQL identifiers                       | MEDIUM       | Fragile to special character names        |
| 11 | ~~HLC counter overflow~~                       | ✅ RESOLVED  | ~~Theoretical at extreme throughput~~     |
