# sqlite-sync

sqlite-sync is a local-first SQLite sync engine for web apps, with reactive queries,
offline persistence, and CRDT-based replication.

## What sqlite-sync does

- Local-first SQLite data layer for your web apps.
- Runs reactive queries with full SQLite support, typed through Kysely and React hooks.
- Automatically resolves write conflicts using Last-Write-Wins per-field replication.
- Supports real schema migrations, including renames and table/column drops.
- Persists local state across reloads and coordinates updates across browser tabs.
- Syncs with a remote server when available, while continuing to work locally when offline.
- Includes Cloudflare sync helpers, browser devtools, and recovery tools for production apps.

## Packages

| Package | Purpose | Use when |
| --- | --- | --- |
| `@sqlite-sync/core` | Core sync engine, schema builder, worker runtime, CRDT primitives | You need SQLite sync in browser/runtime code |
| `@sqlite-sync/react` | React context + hooks (`useDb`, `useDbQuery`, `useDbState`, `useDbEvent`) | You want idiomatic React bindings |
| `@sqlite-sync/devtools` | Floating in-app devtools dialog for inspecting registered databases | You want a browser-side debug UI while developing |
| `@sqlite-sync/cloudflare` | Durable Object adapter + execution helpers | You run sync backend on Cloudflare |
| `@sqlite-sync/ai` | AI agent tools: generated schema doc + AI SDK `ToolSet` | You want to expose a synced database to an AI agent |

## Quick Start (Browser + Worker + React)

### 1) Install

```bash
pnpm add @sqlite-sync/core @sqlite-sync/react kysely

# Optional: floating browser devtools UI
pnpm add @sqlite-sync/devtools
```

### 2) Define schema and db context

```ts
// src/db-schema.ts
import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  tombstone?: boolean;
};

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_todo", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
}));

export const syncDbSchema = createSyncDbSchema({ migrations })
  .addTable<Todo>()
  .withConfig({ baseTableName: "_todo", crdtTableName: "todo" })
  .build();
```

```ts
// src/db.ts
import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { syncDbSchema } from "./db-schema";

export const { useDb, DbProvider, useDbQuery, useDbState, useDbEvent } = createDbContext(syncDbSchema);

export async function initDb() {
  const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });

  return createSyncedDb({
    dbId: "app-db",
    worker,
    workerProps: undefined,
    syncDbSchema,
  });
}
```

### 3) Start worker (with optional remote sync)

```ts
// src/db-worker.ts
import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { syncDbSchema } from "./db-schema";

await startDbWorker({
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: "localhost:8787",
        party: "event-log-server",
        room: "main",
      }),
  }),
});
```

Remote sync is optional. If you only need local persistence, call `startDbWorker({ syncDbSchema })` and omit `createRemoteSource`.

### 4) Use in React

```tsx
import { generateId } from "@sqlite-sync/core";
import { useDb, useDbQuery } from "./db";

export function TodoList() {
  const { db } = useDb();

  // Reactive query: this component re-renders when writes change the "todo" table.
  const { data: todos } = useDbQuery(
    (kdb) => kdb.selectFrom("todo").selectAll().orderBy("id", "asc"));

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          // Flow: write locally first; query refetches immediately and the worker syncs changes in the background.
          db.executeKysely((kdb) =>
            kdb.insertInto("todo").values({
              id: generateId(),
              title: "New Todo",
              completed: false,
            }),
          );
        }}
      >
        Add
      </button>
      <pre>{JSON.stringify(todos, null, 2)}</pre>
    </div>
  );
}
```

### 5) Optional: mount devtools

`@sqlite-sync/devtools` renders a floating `SQLite Sync` button that opens a dialog with a sidebar, database selector, and query tooling.

```tsx
import { SQLiteSyncDevtools } from "@sqlite-sync/devtools";

export function AppShell() {
  return (
    <>
      <App />
      <SQLiteSyncDevtools />
    </>
  );
}
```

Database instances register automatically when `createSyncedDb()` completes and unregister on `dispose()`, so mounting the component once near the app root is enough.

Current query runner rules:
- Worker DB queries are read-only.
- Memory DB queries may write only to CRDT tables.
- The UI executes a single SQL statement at a time and shows raw JSON results.

## Cloudflare Sync Backend (Durable Object)

`@sqlite-sync/cloudflare` provides a Durable Object adapter for deployments that need remote sync.

```ts
// apps/server/event-log-server.ts
import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { syncDbSchema } from "../src/db-schema";

export class EventLogServer extends Server<Env> {
  private remoteHandler!: RemoteHandler;

  onStart() {
    const { remoteHandler } = durableObjectAdapter.createCrdtStorage({
      storage: this.ctx.storage,
      nodeId: this.ctx.id.toString(),
      syncDbSchema,
      crdtEventsTable: "crdt_events",
      batchSize: 100,
      broadcastPayload: (payload) => this.broadcast(payload),
    });
    this.remoteHandler = remoteHandler;
  }

  onMessage(connection: Connection, message: string) {
    const result = this.remoteHandler.handleMessage(message);
    if (result.success) {
      connection.send(result.payload);
    }
  }
}

export default {
  fetch: (request: Request, env: Env) =>
    routePartykitRequest(request, env).then((res) => res || new Response("Not Found", { status: 404 })),
} satisfies ExportedHandler<Env>;
```

## AI Agent Tools

`@sqlite-sync/ai` gives an AI SDK (v6) agent read-only access to a synced database. `createAiDbAccess` lives next to the CRDT storage (e.g. in a Durable Object) and serves a cached markdown schema doc generated from the schema plus app-provided descriptions; `createDbTools` turns that access — or an RPC stub proxying to it — into an AI SDK `ToolSet`. See [`packages/ai`](./packages/ai) for usage.

## How Sync Works

Runtime model:

1. Active tab executes reads/writes against in-memory reactive SQLite.
2. A dedicated worker persists events/state using OPFS SQLite.
3. Worker can sync CRDT event batches with a remote server (optional).

### Recovery and Storage Versioning

The worker detects when the persisted local DB has drifted from the remote event log
(de-sync) or no longer matches the deployed schema. To recover, ask the elected worker to
reload all tabs for a `dbId` — optionally wiping the persisted worker DB so the next startup
re-syncs from scratch:

```ts
// Reload all tabs, keep the persisted worker DB.
await syncedDb.requestReload({ clean: false });

// Destructive recovery: reload all tabs and wipe the persisted DB on next startup.
await syncedDb.requestReload({ clean: true });
```

To force a wipe across an incompatible deploy, bump `storageVersion` in `startDbWorker`; the
elected worker wipes the local DB on startup when the stored version no longer matches. See
[the docs](./docs.md#reload-and-recovery) for details.

## Feature Highlights

- `createSyncedDb()` for client orchestration (worker attach, snapshot hydration, sync state).
- Live query primitives via `db.createLiveQuery(...)`.
- React hooks over the same engine: `useDb`, `useDbQuery`. Identical `useDbQuery` calls within the same provider share one live query when SQL and parameter values match.
- Optional floating devtools UI via `@sqlite-sync/devtools`.
- Online/offline toggles with explicit sync state (`online | offline | pending`).
- De-sync and schema-mismatch detection, with reload/reset recovery via `requestReload({ clean })`.
- Forced local-DB wipes across incompatible deploys via the `storageVersion` worker option.
- Worker and server protocol types exported from `@sqlite-sync/core/worker` and `@sqlite-sync/core/server`.
- Extensible CRDT schema and migrations (`createSyncDbSchema`, `createMigrations`).
- AI agent tools via `@sqlite-sync/ai` (schema doc generation + AI SDK `ToolSet`).

## Known Constraints and Requirements

- Browser requirements: Web Workers + Web Locks + OPFS-capable SQLite WASM environment.
- Call `dispose()` on `SyncedDb` when tearing down long-lived app sessions.
- CRDT tables should avoid non-primary unique constraints unless conflict policy is handled at the app layer.

## Monorepo Development Commands

```bash
pnpm install
pnpm dev            # Example app
pnpm dev:server     # Example Cloudflare/PartyKit server
pnpm build
pnpm typecheck
pnpm format
```

## Examples and Benchmarks

- Example app: [`apps/example`](./apps/example)
- Watchlist app: [`apps/watchlist`](./apps/watchlist)
- Benchmarks: [`apps/benchmarks`](./apps/benchmarks)

## Credits

This library was inspired by James Long's talk ["CRDTs for Mortals"](https://www.youtube.com/watch?v=DEcwa68f-jY) (2019) and Johannes Schickling's [LiveStore](https://livestore.dev/).

## License

MIT
