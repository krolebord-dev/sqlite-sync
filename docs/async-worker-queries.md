# Async Worker Queries

## Current Architecture

All client-side queries run synchronously on the main thread against an in-memory SQLite database.

```
Tab (in-memory SQLite)          Worker (OPFS SQLite)
├── ALL reads (sync)            ├── Persistence
├── ALL mutations (sync)        ├── Receives tab events via pushTabEvents
├── CRDT triggers + views       ├── Remote sync (WebSocket)
└── Reactive subscriptions      └── Snapshot provider on startup
    (SQLite update_hook)
```

The worker DB is purely a persistence and sync backend. Everything user-facing is synchronous on the main thread.

### Query Categories

1. **Initial render queries** — run when a React component mounts, must be synchronous so components render without async handling (`useSyncExternalStore` + `getSnapshot`)
2. **Live query refetches** — run when underlying data changes (any subscribed table). Currently synchronous, but no consumer relies on synchronous delivery
3. **Mutations** — triggered by user actions. Currently synchronous via CRDT view triggers. No consumer relies on synchronous completion

### Current Data Flow

```
React Component
    │
    ├── useDbQuery(query)
    │       │
    │       ▼
    │   resolveQuery → { sql, parameters }
    │       │
    │       ▼
    │   reactiveDb.createLiveQuery (memoized per sql)
    │       │
    │       ▼
    │   useSyncExternalStore
    │       │ subscribe          │ getSnapshot
    │       ▼                    ▼
    │   table:<name> events     Prepared statement execution
    │   (SQLite commit hook)    (LRU cached, sync)
    │
    └── mutation: db.db.executeKysely(...)
            │
            ▼
        CRDT view INSTEAD OF trigger
            │
            ▼
        storage.applyOwnEvent (sync, in-memory)
            │
            ├── persists to persisted_crdt_events
            ├── applies LWW to physical base table
            └── on commit → sync producer → workerClient.pushTabEvents()
                                                  │
                                                  ▼
                                        Worker (OPFS) → Remote
```

## Proposed Refactor

Keep initial render queries synchronous on the in-memory DB. Move live query refetches and mutations to the worker DB asynchronously.

```
Tab (in-memory SQLite)          Worker (OPFS SQLite)
├── Initial render reads (sync) ├── Persistence
├── Reactive subscription cache ├── Live query refetches (async)
└── (read-only after init)      ├── Mutations (async)
                                ├── CRDT triggers + event generation
                                ├── Remote sync (WebSocket)
                                └── Table change notifications → tab
```

### Proposed Data Flow

```
React Component
    │
    ├── useDbQuery(query)
    │       ├── First call: sync read from in-memory DB (same as today)
    │       └── Subsequent refetches: async read from worker DB
    │               │
    │               ▼
    │           BroadcastChannel request → Worker executes query → response
    │               │
    │               ▼
    │           Cache result, notify useSyncExternalStore
    │
    └── mutation: db.db.executeKysely(...)
            │
            ▼
        BroadcastChannel request → Worker
            │
            ├── CRDT triggers fire in worker DB
            ├── Applies LWW to physical base table
            ├── Syncs to remote
            └── Notifies tab: tables changed → triggers async refetches
```

## Pros

### Main thread relief

Mutations and refetch queries move off the main thread. For complex queries (joins, aggregations, large result sets), this prevents jank. Currently every `executeKysely` and every reactive refetch blocks rendering.

### Larger dataset viability

The in-memory DB currently duplicates the entire dataset. With async worker queries for refetches, the in-memory DB only needs to serve initial renders, not maintain a full live replica.

### Multi-tab write consistency

Currently each tab has its own in-memory DB with independent CRDT triggers. If mutations route through the shared worker, you get a single write serialization point — no need for `pushTabEvents`. The worker becomes the single writer, and tabs become read caches.

### Simpler event flow

Current: tab mutation → CRDT triggers in memory → `pushTabEvents` → worker applies → worker syncs remote.
Proposed: tab sends mutation → worker executes with CRDT triggers → worker syncs remote.
The tab→worker event push step is eliminated.

### Worker already has CRDT infrastructure

The worker already applies CRDT events from remote via `handleCrdtEventApply`. Extending it to handle local mutations is incremental.

## Cons

### Mutation-to-UI latency gap

Currently the full cycle is synchronous:
```
user clicks → executeKysely → triggers → update_hook → reactive re-read → React re-render
```

With async mutations there are ~2 BroadcastChannel round-trips + worker query execution (~5-15ms). Users may see a frame or two of stale UI after an action.

### Optimistic update pressure

To compensate for the latency gap, optimistic updates may be needed — apply mutations to the in-memory DB immediately, then reconcile with the worker. This adds complexity rather than removing it.

### Hybrid model complexity

Two different code paths in `createLiveQuery`:
- `getSnapshot()` must remain synchronous for `useSyncExternalStore` — needs a cached last-known result
- Refetches are async, introducing race conditions (e.g. new parameters arrive while a refetch is in-flight)
- Error states and loading states need representation

### Loss of transactional read-after-write

Currently within `executeTransaction`, you can mutate and immediately read consistent state. With async worker mutations, synchronous `insert → select` in one block is no longer possible.

### Reactive subscription mechanism changes

The current system uses SQLite's built-in `sqlite3_update_hook` on commit to detect table changes. With worker mutations, the worker must notify tabs about table changes via `BroadcastChannel`, replacing a built-in SQLite feature with a custom notification protocol.

### Error handling surface change

Mutations currently throw synchronously. Async mutations require Promise-based error handling, changing every `db.db.executeKysely()` call site.

## Trade-off Summary

| Aspect | Current (all sync) | Proposed (hybrid) |
|--------|--------------------|--------------------|
| Initial render | Sync, instant | Sync, instant (same) |
| Mutation feedback | Instant (0ms) | Delayed (~5-15ms) or needs optimistic updates |
| Main thread load | All queries + mutations | Only initial render queries |
| Complexity | One DB, one path | Two DBs, two query paths, async reconciliation |
| Multi-tab writes | Each tab writes independently | Single serialized writer |
| API surface | Sync everywhere | Mixed sync/async |

## Alternative Approaches

Before committing to the full hybrid model, consider targeted alternatives:

- **Selective async queries**: Keep mutations sync in-memory, but offer an `useAsyncDbQuery` hook for expensive reads that should run on the worker. Addresses main thread jank without changing the mutation path.
- **Partial snapshots**: If memory pressure is the concern, explore lazy table loading or partial snapshots instead of duplicating the full DB.
- **Worker-only for heavy aggregations**: Route specific expensive queries to the worker on-demand, without changing the default query path.

## Status

**Status**: Proposal — not yet implemented.
