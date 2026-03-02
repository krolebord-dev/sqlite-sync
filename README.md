# sqlite-sync

Offline-first SQLite synchronization with CRDT event replication for local-first web apps.

## Features

- Local-first SQLite reads and writes in the browser.
- Reactive query subscriptions that re-run on relevant table changes.
- Durable browser state in a Web Worker using OPFS-backed SQLite.
- CRDT event replication for convergence across tabs and remote nodes.
- Typed query support via Kysely.
- Remote sync is optional; local persistence works without a data server.
- Cross-tab coherence via worker state and broadcast channels.

## Packages

| Package | Purpose | Use when |
| --- | --- | --- |
| `@sqlite-sync/core` | Core sync engine, schema builder, worker runtime, CRDT primitives | You need SQLite sync in browser/runtime code |
| `@sqlite-sync/react` | React context + hooks (`useDb`, `useDbQuery`, `useDbState`) | You want idiomatic React bindings |
| `@sqlite-sync/cloudflare` | Durable Object adapter + execution helpers | You run sync backend on Cloudflare |

## Quick Start (Browser + Worker + React)

### 1) Install

```bash
pnpm add @sqlite-sync/core @sqlite-sync/react kysely
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

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext(syncDbSchema);

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
import { useDb, useDbQuery, useDbState } from "./db";

export function TodoList() {
  const { db, state } = useDb();
  const workerState = useDbState();
  const { data: todos } = useDbQuery((kdb) => kdb.selectFrom("todo").selectAll().orderBy("id", "asc"));

  return (
    <div>
      <button type="button" onClick={() => state.goOffline()}>
        {workerState.remoteState}
      </button>
      <button
        type="button"
        onClick={() =>
          db.executeKysely((kdb) =>
            kdb.insertInto("todo").values({
              id: generateId(),
              title: "New Todo",
              completed: false,
            }),
          )
        }
      >
        Add
      </button>
      <pre>{JSON.stringify(todos, null, 2)}</pre>
    </div>
  );
}
```

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

### Durable Object Background Jobs

`do-jobs` provides SQLite-backed job scheduling inside a Durable Object with alarm-driven execution.

```ts
import { createDefineJob, setupJobs, type JobRuntime } from "do-jobs";
import { z } from "zod";

type JobContext = { ctx: DurableObjectState; env: Env };
const defineJob = createDefineJob<JobContext>();

const digestJob = defineJob({ type: "digest" })
  .input(z.object({ userId: z.string() }))
  .handler(async ({ input, context }) => {
    console.log("generate digest for", input.userId, context.env);
  });

export class DigestServer extends Server<Env> {
  private jobs!: JobRuntime;

  async onStart() {
    this.jobs = await setupJobs({
      jobs: [digestJob],
      ctx: this.ctx,
      context: { ctx: this.ctx, env: this.env },
    });
  }

  onAlarm() {
    return this.jobs.onAlarm();
  }

  onMessage() {
    void this.jobs.schedule(digestJob, {
      input: { userId: "u-1" },
      at: Date.now() + 1_000,
    });
  }
}
```

## How Sync Works

Runtime model:

1. Active tab executes reads/writes against in-memory reactive SQLite.
2. A dedicated worker persists events/state using OPFS SQLite.
3. Worker can sync CRDT event batches with a remote server (optional).

## Feature Highlights

- `createSyncedDb()` for client orchestration (worker attach, snapshot hydration, sync state).
- Live query primitives via `db.createLiveQuery(...)`.
- React hooks over the same engine: `useDbQuery`, `useDbState`.
- Online/offline toggles with explicit sync state (`online | offline | pending`).
- Worker and server protocol types exported from `@sqlite-sync/core/worker` and `@sqlite-sync/core/server`.
- Extensible CRDT schema and migrations (`createSyncDbSchema`, `createMigrations`).

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

## License

MIT
