# Sync Implementation Analysis

Comprehensive analysis of the sqlite-sync synchronization implementation across all layers: memory DB (tab), Web Worker (OPFS), WebSocket transport, and server (Cloudflare Durable Objects).

---

## Critical Bugs

### 1. Missing `schema_version` Update After Event Migration

**Files:** `packages/core/src/migrations/migrator.ts:285-328`, `packages/core/src/sqlite-crdt/crdt-storage.ts:168-210`

The `migrateEvent` function in the migrator transforms the event payload through the migration chain but never updates `event.schema_version` to the target version. Since `migrateEvent` mutates and returns the same object, the assignment in `processPersistedEvent` is a no-op:

```typescript
// migrator.ts — schema_version is never updated
const migrateEvent = (event, targetVersion) => {
  // ... applies transformers to event.payload, event.dataset, etc.
  // But does NOT set: event.schema_version = targetVersion
  return event;
};

// crdt-storage.ts — migratedEvent IS event (same reference), so this is a no-op
event.schema_version = migratedEvent.schema_version;
```

**Impact:** Events are stored with their original `schema_version` even though their payload has been migrated. When these events are later pushed to a remote and `migrateEvents()` is called again (in `crdt-sync-remote-source.ts:263`), the migration runs a second time. Non-idempotent migrations like `renameColumn` will fail or corrupt data — renaming a column that was already renamed in the first pass.

### 2. Server Responds Before Events Are Applied

**Files:** `packages/cloudflare/src/durable-object-adapter.ts:300-314`, `packages/core/src/sqlite-crdt/crdt-storage.ts:212-233`

The `handlePushEvents` handler responds with `{ ok: true }` immediately after calling `enqueueLocalEvents()`, but events are not yet applied at that point. The `processEnqueuedEvents` function is async and yields at `await Promise.resolve()` before fetching and processing events:

```typescript
// durable-object-adapter.ts
const handlePushEvents = (request) => {
  crdtStorage.enqueueLocalEvents(request.events);  // Enqueues, starts async processing
  return { success: true, payload: JSON.stringify({ ok: true }) };  // Returns BEFORE events are applied
};

// crdt-storage.ts — processEnqueuedEvents yields before processing
const processEnqueuedEvents = ensureSingletonExecution(async () => {
  while (hasMore) {
    await Promise.resolve();  // <-- yields here, allowing response to be sent
    // ... actual event processing happens after yield
  }
});
```

**Impact:** There is a window where Client A pushes events, gets `ok`, but Client B pulling immediately afterward won't see those events (they are still "pending", and pulls filter by `status: "applied"`). This violates the expected causal ordering guarantee.

---

## Security Concerns

### 3. SQL Injection via Unescaped Identifiers

**Files:** `packages/core/src/sqlite-crdt/apply-crdt-event.ts:90-97`, `packages/cloudflare/src/durable-object-adapter.ts:138-143`

Table names (`dataset`) and column names (keys of `payload`) from CRDT events are interpolated directly into SQL strings without escaping:

```typescript
// apply-crdt-event.ts:90-96
updateItem(opts) {
  db.execute({
    sql: `update ${opts.dataset} set ${keys.map((key) => `${key} = ?`).join(",")} where id = ?`,
    parameters: [...keys.map((key) => opts.payload[key]), opts.itemId],
  });
},
```

The same pattern exists in the Cloudflare adapter (`durable-object-adapter.ts:138-143`).

**Impact:** A malicious peer or compromised server could craft events with SQL injection payloads in the `dataset` or `payload` key fields. The Zod validation in `server-common.ts` validates `dataset` as `z.string()` without any format restriction. While the risk is limited because CRDT events flow through controlled channels, any defense-in-depth strategy should sanitize identifiers.

### 4. No Content Validation for Incoming Events

**File:** `packages/core/src/server/server-common.ts:11-25`

The Zod schema validates event structure but not content:

```typescript
events: z.array(z.object({
  schema_version: z.number(),
  timestamp: z.string(),    // No HLC format validation
  dataset: z.string(),      // No table name validation
  item_id: z.string(),      // No UUID format validation
  payload: z.string(),      // No JSON validity check, no schema match
}))
```

**Impact:** Malformed timestamps could break HLC ordering. Invalid JSON payloads would cause runtime errors during event application. Unknown dataset names would trigger SQL errors. This is noted as planned in `CLAUDE.md` ("Events payload validation").

---

## Correctness Issues

### 5. HLC `mergeHLC` Missing Physical Clock Comparison

**File:** `packages/core/src/hlc.ts:42-51`

The standard HLC merge algorithm requires comparing the local timestamp, remote timestamp, AND the current physical clock to compute the new HLC. The implementation omits the physical clock:

```typescript
mergeHLC(hlc: HLC) {
  // Missing: const now = this.getTimestamp();
  // Should be: new timestamp = max(this.timestamp, hlc.timestamp, now)
  if (this.timestamp === hlc.timestamp) {
    this.counter = Math.max(this.counter, hlc.counter) + 1;
  } else if (this.timestamp > hlc.timestamp) {
    this.counter++;
  } else {
    this.timestamp = hlc.timestamp;
    this.counter = hlc.counter + 1;
  }
}
```

**Impact:** After merging with a remote HLC, the local clock may not advance to wall-clock time even when wall time is ahead of both timestamps. This means events generated after a merge could have timestamps behind the physical clock, reducing the ordering accuracy that HLC is designed to provide. Additionally, there is no maximum drift check — a malicious remote HLC with a far-future timestamp would advance the local clock permanently, affecting all future events.

### 6. `goOnline` During `goOffline` Throws Uncaught Error

**File:** `packages/core/src/sqlite-crdt/crdt-sync-remote-source.ts:84-88, 132-152, 154-162`

If `goOnline()` is called while `goOffline()` is in progress, the state is "pending". `goOnline` calls `initRemote()`, which throws if the state isn't "offline":

```typescript
const initRemote = ensureSingletonExecution(async () => {
  if (remoteState.type !== "offline") {
    throw new Error("Remote source is not offline");  // Throws when state is "pending"
  }
  // ...
});

const goOnline = async () => {
  if (remoteState.type !== "online") {
    await initRemote();  // Throws uncaught if state is "pending"
  }
  // ...
};
```

**Impact:** Calling `goOnline()` during a disconnect produces an unhandled promise rejection, which could crash the worker or leave the sync in a broken state.

### 7. Worker RPC Has No Error Handling or Timeout

**Files:** `packages/core/src/worker-db/db-worker.ts:184-211`, `packages/core/src/worker-db/db-worker-client.ts:38-57`

The worker's RPC message handler has no try/catch. If any RPC method throws synchronously, the error is uncaught and the tab's request promise hangs indefinitely. For async methods, there's no `.catch()`:

```typescript
// db-worker.ts — no error handling
broadcastChannels.requests.onmessage = (event) => {
  const method = rpcTarget[message.method];
  const data = method.apply(null, message.args);  // No try/catch

  if (data instanceof Promise) {
    data.then((result) => { /* send response */ });  // No .catch()
  }
};

// db-worker-client.ts — no timeout (noted as TODO)
const queryWorker = (method, args) => {
  // TODO Add timeout
  const promise = createDeferredPromise<unknown>();  // No timeout configured
  workerRequestsMap.set(requestId, promise);
  // ...
};
```

**Impact:** A worker error leaves tab requests permanently pending. The tab has no mechanism to detect or recover from worker failures.

---

## Resource & Performance Issues

### 8. WebSocket Request Map Leaks on Timeout

**File:** `packages/core/src/web-socket/ws-remote-source.ts:25-57`

When a WebSocket request times out via `createDeferredPromise`, the entry in `requestsMap` is only cleaned up when the server eventually responds. If the server never responds, the entry leaks:

```typescript
const pushEvents = async (request) => {
  const requestId = crypto.randomUUID();
  const promise = createDeferredPromise<EventsPushResponse>({ timeout: 5000 });
  requestsMap.set(requestId, promise);  // Leaked if server never responds
  socket.send(JSON.stringify(wsRequest));
  return promise.promise;
};
```

**Impact:** Over time with unreliable networks, `requestsMap` accumulates stale entries that are never cleaned up.

### 9. Memory DB Events Never Compacted

**Files:** `packages/core/src/memory-db/memory-db.ts:67-84`

The in-memory database stores all CRDT events in `persisted_crdt_events` indefinitely. There is no compaction mechanism.

**Impact:** RAM usage grows unboundedly in long-running tabs. The worker DB (OPFS) and server (D1) have the same issue but with disk storage, which is less critical. This is a known planned feature per `CLAUDE.md`.

### 10. `afterSyncId: 0` Falsy Check Inconsistency

**File:** `packages/core/src/sqlite-crdt/events-batch-filters.ts:9-11`

```typescript
if (opts.afterSyncId) {  // Falsy check: 0 is treated as "no filter"
  query = query.where("sync_id", ">", opts.afterSyncId);
}
```

The tab's push sync ID is initialized to `0` (`sync-db.ts:93`), while the worker's is initialized to `-1` (`db-worker.ts:228`). With `afterSyncId: 0`, the filter isn't applied, meaning the first push from a tab returns ALL events regardless of sync_id. The worker's default of `-1` (truthy) works correctly.

**Impact:** The inconsistency between `0` and `-1` defaults creates subtly different behavior for the initial sync. While functionally correct in practice (the tab starts fresh), it could cause confusion and the first push may process unnecessary events.

### 11. Pull Timeout May Be Too Aggressive

**File:** `packages/core/src/web-socket/ws-remote-source.ts:43-46`

Pull events has a 2-second WebSocket timeout while push events has 5 seconds:

```typescript
const pullEvents = async () => {
  const promise = createDeferredPromise<GetEventsBatch>({ timeout: 2000 });
  // ...
};
```

**Impact:** Under moderate server load, pull requests that take >2 seconds will time out and trigger retries unnecessarily. The retry logic applies 3 retries with backoff, but even a consistently slow (2.1s) response would exhaust all retries and trigger going offline.

---

## Design Limitations

### 12. No Recovery for Failed Events

**File:** `packages/core/src/sqlite-crdt/crdt-storage.ts:197-199`

Events that fail to apply are permanently marked as "failed" with no retry mechanism:

```typescript
catch (error) {
  console.error("Error applying enqueued CRDT event", error);
  event.status = "failed";
}
```

**Impact:** Data can be silently lost if an event fails to apply (e.g., due to a transient error or migration issue). There is no way to retry failed events or notify the application.

### 13. `onEventsAvailable` Discards Remote Sync ID

**File:** `packages/core/src/sqlite-crdt/crdt-sync-remote-source.ts:99-103`

When the remote source notifies about new events, the `newSyncId` parameter is ignored:

```typescript
const factoryResult = await tryCatchAsync(async () => {
  return await remoteFactory?.({
    onEventsAvailable: () => {          // newSyncId parameter is not captured
      pullEvents({ includeSelf: false }); // Falls back to pullSyncId.current
    },
  });
});
```

**Impact:** The `newSyncId` could be used to skip unnecessary pulls when the local state is already up-to-date. Without it, every notification triggers a full pull from the last known sync point.

### 14. Worker Lock Has No Failure Recovery

**File:** `packages/core/src/worker-db/db-worker.ts:268-279`

The worker acquires an exclusive Web Lock and holds it forever. If lock acquisition fails, there's only a console.error:

```typescript
await navigator.locks.request(lockName, { mode: "exclusive" }, async (lock) => {
  if (!lock) { return; }
  await createDbWorker(config, opts);
  await new Promise<void>(() => {}); // Holds lock forever
});
console.error("Failed to acquire lock"); // No recovery, no notification to tab
```

**Impact:** If lock acquisition fails (e.g., another worker instance exists), the tab receives no notification and will hang waiting for the worker to respond.

### 15. Snapshot Creation Requires WAL Mode Switch

**File:** `packages/core/src/worker-db/db-worker.ts:156-163`

Creating a snapshot requires temporarily disabling WAL mode:

```typescript
getSnapshot: () => {
  db.execute("PRAGMA journal_mode=off");
  const file = db.createSnapshot();
  db.execute("PRAGMA journal_mode=WAL");
  return { file, syncId: localSyncId.current, schemaVersion: migrator.currentSchemaVersion };
},
```

**Impact:** Switching journal modes can trigger a WAL checkpoint, which may be slow for large databases. While the worker is single-threaded (so no concurrent write risk), the performance cost could affect tab initialization time.

### 16. No Event Deduplication

**File:** `packages/core/src/sqlite-crdt/crdt-storage.ts:89-111`

Events are persisted without checking for duplicates. CRDT events don't have a globally unique ID — `sync_id` is locally assigned and the HLC `timestamp` is unique per node but not checked:

```typescript
const enqueueEvents = (origin, events) => {
  transaction(() => {
    for (const event of events) {
      storage.persistEvent({ ...event, sync_id: ++storage.syncId.current });
      // No deduplication check
    }
  });
};
```

**Impact:** Retried network requests can cause the same events to be persisted and processed multiple times. While LWW semantics ensure the final state is correct, this wastes storage and processing.

---

## Summary

| # | Severity | Issue | Location |
|---|----------|-------|----------|
| 1 | **Critical** | Missing schema_version update causes double migration | `migrator.ts`, `crdt-storage.ts` |
| 2 | **Critical** | Server responds before events are applied | `durable-object-adapter.ts` |
| 3 | **High** | SQL injection via unescaped identifiers | `apply-crdt-event.ts`, `durable-object-adapter.ts` |
| 4 | **High** | No content validation for incoming events | `server-common.ts` |
| 5 | **Medium** | HLC merge missing physical clock comparison | `hlc.ts` |
| 6 | **Medium** | goOnline during goOffline throws uncaught error | `crdt-sync-remote-source.ts` |
| 7 | **Medium** | Worker RPC has no error handling or timeout | `db-worker.ts`, `db-worker-client.ts` |
| 8 | **Low** | WebSocket request map leaks on timeout | `ws-remote-source.ts` |
| 9 | **Low** | Memory DB events never compacted | `memory-db.ts` |
| 10 | **Low** | afterSyncId:0 falsy check inconsistency | `events-batch-filters.ts` |
| 11 | **Low** | Pull timeout too aggressive at 2s | `ws-remote-source.ts` |
| 12 | **Low** | No recovery for failed events | `crdt-storage.ts` |
| 13 | **Low** | onEventsAvailable discards sync ID | `crdt-sync-remote-source.ts` |
| 14 | **Low** | Worker lock has no failure recovery | `db-worker.ts` |
| 15 | **Low** | Snapshot requires WAL mode switch | `db-worker.ts` |
| 16 | **Low** | No event deduplication | `crdt-storage.ts` |
