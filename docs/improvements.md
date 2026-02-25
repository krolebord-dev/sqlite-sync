# Improvements

## 1. Version mismatch reload prompt

**File:** `crdt-sync-remote-source.ts:228-231`

When the client receives events with a schema version higher than its own, it goes offline silently. The user has no indication of why sync stopped or that a reload would fix it.

**Improvement:** Add an `onVersionMismatch` callback to the sync configuration. The library calls it when a schema version mismatch is detected, allowing the app to display a "New version available — please reload" prompt or trigger an automatic reload.

```typescript
createSyncedDb({
  // ...
  onVersionMismatch: ({ localVersion, remoteVersion }) => {
    showReloadPrompt("A new version is available. Please reload the app.");
  },
});
```

## 2. Worker crash detection and recovery

**File:** `db-worker-client.ts:37-133`, `sync-db.ts`

If the Web Worker is killed (OOM, browser kill), there is no `worker.onerror` handler. All pending RPC calls hang for 30 seconds before timing out. The tab enters an unrecoverable state — no retry logic exists, and `createSyncedDb` must be called again externally.

### Layer 1: Detect crashes immediately

Add `worker.onerror` and `worker.onmessageerror` handlers in `createSyncedDb` (where the `Worker` reference is available). On error:

- Reject **all** pending deferred promises at once instead of waiting 30s per-request
- Mark the client as disposed
- Emit a `"worker-crashed"` event consumers can listen for

This handles hard crashes (OOM, uncaught exceptions).

```typescript
worker.onerror = (event) => {
  for (const [id, deferred] of workerRequestsMap) {
    deferred.reject(new Error("Worker crashed"));
    workerRequestsMap.delete(id);
  }
  isDisposed = true;
  eventTarget.dispatchEvent("worker-crashed", { error: event });
};
```

### Layer 2: Detect silent deaths via heartbeat

`worker.onerror` doesn't fire for every failure mode (e.g., browser kills the worker's process silently). A lightweight heartbeat addresses this:

- Client sends a `postState` RPC every ~5s
- If it times out (e.g., 3s instead of the normal 30s), treat as crash
- Mirrors the existing pattern where the worker already polls for client liveness via Web Lock

### Layer 3: Auto-recovery (optional)

Instead of leaving the app in a dead state, `createSyncedDb` could accept a **worker factory** (`() => Worker`) instead of a raw `Worker` instance. On crash:

- Dispose the old client and in-memory DB
- Spawn a new worker from the factory
- Re-run the full init sequence (get snapshot, rebuild reactive DB)
- Resume transparently

### Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| Event only (Layer 1) | Simple, consumer controls recovery | App must handle restart logic |
| Heartbeat (Layer 1+2) | Catches all crash types | Adds background traffic, complexity |
| Auto-recovery (all 3) | Transparent to consumer | Hard to get right (in-flight queries, stale references, React state) |

### Recommendation

Implement **Layer 1 + expose a recovery hook**. Detect crashes, reject fast, and let the consumer decide how to restart. The heartbeat (Layer 2) is a worthwhile addition for catching silent kills. Full auto-recovery (Layer 3) is risky since consumers hold references to the old `reactiveDb` and in-memory state.
