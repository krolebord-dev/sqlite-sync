# Simple Reset Plan

## Goal

Implement simple page-reload based restart/reset functionality.

The API should be:

```ts
syncedDb.requestReload({ clean: boolean }): Promise<void>
```

This API asks the elected worker to broadcast a reload request to all tabs. Tabs then reload the page, which naturally recreates tab-local memory DB state, live queries, hooks, and worker clients.

## Contract

- `requestReload({ clean: false })`
  - Broadcasts a reload request to all tabs for the same `dbId`.
  - Does not wipe persisted OPFS worker DB files.
  - Used when the app wants a process-level reconnect.

- `requestReload({ clean: true })`
  - Broadcasts a reload request to all tabs for the same `dbId`.
  - Before broadcasting, the elected worker writes a reset request epoch to worker-accessible durable storage.
  - On the next startup, whichever worker wins the election reads the reset request epoch and compares it to the last applied reset epoch.
  - If the request epoch has not been applied and the request is not stale (see "Reset request TTL"), the elected worker initializes with `clearOnInit: true`.
  - After successful initialization, the elected worker records the epoch as applied.
  - Used as a destructive recovery path when the durable worker DB may be de-synced.

This API does not attempt to preserve pending in-memory tab events. It is a recovery/reload flow, not a hot runtime reset.

Accepted v1 behavior: a throttled background tab may process the reload broadcast late and push pre-reset tab-memory events into the freshly wiped DB before its own reload fires. CRDT events are self-contained, so this cannot corrupt state — some pending events may simply survive the reset nondeterministically. Guarding against this (rejecting pushes from clients on an old reload epoch) would rebuild the stale-instance machinery this plan deliberately avoids.

## Reset State

The reset decision must be owned by the elected worker, not by tabs during `createSyncedDb`.

Use worker-accessible durable storage via a small in-repo IndexedDB wrapper (no new dependency) exposing `get`/`set` operations, with keys scoped by `dbId`:

```ts
type ResetRequest = {
  epoch: string;
  requestedAt: number;
};
```

- `sqlite-sync-reset-request-${dbId}` stores the latest requested reset.
- `sqlite-sync-reset-applied-${dbId}` stores the last successfully applied reset epoch.

Reset requests are only ever written for `clean: true`, so the record does not need a `clean` field.

The elected worker applies a clean reset only when:

```ts
resetRequest.epoch !== lastAppliedResetEpoch &&
Date.now() - resetRequest.requestedAt <= RESET_REQUEST_TTL_MS
```

The applied epoch must be written only after the worker has successfully initialized with `clearOnInit: true`.

### Reset request TTL

```ts
const RESET_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes
```

A clean reset is a recovery action for a de-sync detected now. If the reload never happens (broadcast lost, tab crashed mid-reload, browser killed the page), the request must not fire on an arbitrary later cold start and silently wipe local-only writes accumulated since.

On startup, if the reset request is older than the TTL, the elected worker ignores it and deletes it from durable storage.

## Implementation Steps

1. Discard the runtime restart/stale-instance implementation from the current branch.

2. Add worker RPC:

```ts
requestReload(options: { clean: boolean }): Promise<void>
```

3. Add worker notification:

```ts
{
  notificationType: "reload-requested";
  reloadEpoch: string;
  clean: boolean;
}
```

4. Add a minimal IndexedDB wrapper in `packages/core` (e.g. `src/idb-store.ts`):
   - Plain async `get(key)` / `set(key, value)` / `delete(key)` over a single object store.
   - No external dependency.
   - Usable from both worker and tab contexts (only the worker needs it for now).

5. In the worker:
   - Implement `requestReload`.
   - Generate a `reloadEpoch`.
   - If `clean` is true, write a reset request to durable storage **before** broadcasting and before resolving the RPC, so the epoch is durably stored no matter which path triggers the reload:

```ts
{
  epoch: reloadEpoch,
  requestedAt: Date.now()
}
```

   - Broadcast `reload-requested` to `broadcastChannels.responses`.
   - Do not dispose or recreate the worker runtime.
   - Do not flush pending tab events.

6. During worker startup:
   - After the worker wins the exclusive worker lock, read the latest reset request and last applied reset epoch from durable storage.
   - If the reset request is older than `RESET_REQUEST_TTL_MS`, ignore it and delete it.
   - If there is an unapplied, non-stale reset request, pass `clearOnInit: true` into the worker DB runtime initialization.
   - Otherwise use the normal `config.clearOnInit` value.
   - After successful runtime initialization with the reset request, write `lastAppliedResetEpoch = resetRequest.epoch`.
   - This prevents repeated wipes if the winning tab closes and another worker later becomes leader.

7. In `createSyncedDb`:
   - Add public `requestReload(options: { clean: boolean }): Promise<void>`.
   - Listen for `reload-requested` and call `globalThis.location?.reload()`.
   - Primary path: the initiating tab receives the broadcast like every other tab. BroadcastChannel excludes only the exact posting channel *object*; the worker posts from its own `responses` object in a separate thread, so self-delivery to the initiating tab is guaranteed.
   - Fallback: after the RPC resolves, schedule a short-delay direct reload (e.g. `setTimeout(() => globalThis.location?.reload(), 250)`). In the normal case the page is already unloading and the timeout never fires.
   - Document that the returned promise may never settle in the caller — the page unloads first.

8. Revisit the existing devtools clear flow:
   - The current localStorage clear flag can race because it is consumed by tabs before worker election.
   - Either leave it as devtools-only behavior or migrate it to the same worker-owned reset epoch mechanism.
   - The recovery path must not depend on the localStorage clear flag.

## Tests

- Worker RPC broadcasts `reload-requested` with the expected `clean` value.
- `requestReload({ clean: true })` writes a reset request epoch before broadcasting reload.
- `requestReload({ clean: false })` does not write a clean reset request.
- On startup, the elected worker applies `clearOnInit: true` when the reset request epoch differs from the applied epoch and the request is within the TTL.
- A reset request older than 10 minutes is ignored and deleted, and no wipe happens.
- After successful clean initialization, the elected worker records the applied epoch.
- A later worker election with the same reset request epoch does not wipe again.
- If initialization fails before recording the applied epoch, a later elected worker can retry the reset.
- Multi-tab clean reload: the reset applies even when a *different* tab's worker wins the post-reload election (the original race the epoch mechanism exists to fix).
- IndexedDB wrapper: `get` returns `undefined` for missing keys, `set` round-trips values, `delete` removes them.

## Notes

- The method name should stay explicit: `requestReload`, not `restart`.
- This avoids adding a long-lived "stale" runtime state to normal DB instances.
- Future sync/live-query/worker changes should not need special hot-reset handling.
- The clean reset decision must not be made from immutable worker init config alone; otherwise a later worker can repeat an already-applied wipe.
