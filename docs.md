# sqlite-sync Documentation

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT support for local-first applications. All writes happen locally against an in-memory SQLite database, persist to OPFS via a Web Worker, and sync automatically to a remote server over WebSocket.

## Table of Contents

- [Installation](#installation)
- [Architecture Overview](#architecture-overview)
- [Schema Definition](#schema-definition)
- [Client Setup](#client-setup)
- [React Integration](#react-integration)
- [Server Setup](#server-setup)
- [Queries](#queries)
- [Mutations](#mutations)
- [Sync State](#sync-state)
- [Migrations](#migrations)
- [Server-Side Mutations](#server-side-mutations)
- [Vite Configuration](#vite-configuration)
- [API Reference](#api-reference)

---

## Installation

```bash
# Core sync engine
pnpm add @sqlite-sync/core

# React bindings
pnpm add @sqlite-sync/react

# Cloudflare Durable Objects adapter (server)
pnpm add @sqlite-sync/cloudflare

# Durable Object jobs runtime
pnpm add do-jobs

# Optional: any Standard Schema v1 validator for jobs API (zod, valibot, arktype, etc.)
pnpm add zod
```

Peer dependencies:

| Package | Peers |
|---------|-------|
| `@sqlite-sync/core` | `@sqlite.org/sqlite-wasm`, `kysely` |
| `@sqlite-sync/react` | `react ^18 \|\| ^19`, `kysely` |
| `@sqlite-sync/cloudflare` | `@cloudflare/workers-types`, `kysely` |

---

## Architecture Overview

sqlite-sync uses a three-layer sync model:

```
Browser Tab (in-memory SQLite)
    ↕ BroadcastChannel
Web Worker (OPFS-persisted SQLite)
    ↕ WebSocket
Remote Server (Cloudflare Durable Object SQLite)
```

**Browser Tab** — Holds a reactive in-memory SQLite database. All reads and writes happen here synchronously. CRDT events are generated automatically via SQL triggers when you insert, update, or delete through CRDT views.

**Web Worker** — Persists data to OPFS (Origin Private File System) so it survives page reloads. Receives events from tabs via BroadcastChannel, stores them in an event log, and syncs with the remote server over WebSocket.

**Remote Server** — A Cloudflare Durable Object with embedded SQLite storage. Receives events from clients, applies them using last-write-wins conflict resolution, and broadcasts changes to all connected clients.

### CRDT Event Flow

Every mutation generates a CRDT event containing:
- A **Hybrid Logical Clock (HLC)** timestamp for causal ordering
- The **dataset** (table name), **item_id**, and **payload** (changed columns)
- An event **type**: `item-created`, `item-updated`, or `item-deleted`

Events are conflict-free — concurrent edits to different columns merge automatically, and concurrent edits to the same column resolve via last-write-wins using HLC comparison.

---

## Schema Definition

A schema defines your CRDT-enabled tables and their migrations. The schema is shared between client and server.

### Defining Migrations

Use `createMigrations` to define versioned DDL operations:

```ts
// src/migrations.ts
import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

export const migrations = createMigrations((b) => ({
  // Version 0: initial schema
  0: [
    b.createTable("_todo", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
  // Version 1: add a column
  1: [
    b.addColumn({ table: "_todo", column: "priority", type: "integer", defaultValue: 0 }),
  ],
}));
```

**Every CRDT table must have:**
- An `id` column of type `text` (primary key)
- A `tombstone` column of type `boolean` (soft-delete flag)

The base table name uses an underscore prefix by convention (e.g., `_todo`). The CRDT view (without the prefix) is what you query and mutate against.

### Available Migration Steps

| Step | Description |
|------|-------------|
| `b.createTable(name, builder)` | Create a new table |
| `b.dropTable(name)` | Drop a table (drops its events too) |
| `b.addColumn({ table, column, type, defaultValue })` | Add a column to an existing table |
| `b.dropColumn({ table, column })` | Drop a column |
| `b.renameTable({ oldTable, newTable })` | Rename a table |
| `b.renameColumn({ table, oldColumn, newColumn })` | Rename a column |
| `b.createIndex(name, builder)` | Create an index |
| `b.dropIndex(name)` | Drop an index |

Migration steps automatically generate **event transformers** — when syncing events across clients at different schema versions, events are migrated on the fly (e.g., renaming a column in a payload, adding a default value for a new column).

### Building the Schema

Chain `.addTable<Type>().withConfig(...)` for each CRDT table, then call `.build()`:

```ts
// Type for rows in the todo table
export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  priority: number;
  tombstone?: boolean;
};

export const syncDbSchema = createSyncDbSchema({ migrations })
  .addTable<Todo>()
  .withConfig({ baseTableName: "_todo", crdtTableName: "todo" })
  .build();

// For multiple tables:
export const syncDbSchema = createSyncDbSchema({ migrations })
  .addTable<Todo>()
  .withConfig({ baseTableName: "_todo", crdtTableName: "todo" })
  .addTable<Tag>()
  .withConfig({ baseTableName: "_tag", crdtTableName: "tag" })
  .build();
```

The schema carries three phantom types used for type inference:
- `~clientSchema` — Used by React hooks. Includes both base tables (read-only) and CRDT views (read-write).
- `~serverSchema` — Used by server-side `executeKysely`. Base tables only (read-only via Kysely types).
- `~mutationsSchema` — Used by `enqueueEvent` for typed CRDT payloads.

---

## Client Setup

### 1. Create the Web Worker

The worker is a separate file that calls `startDbWorker`. It handles OPFS persistence and remote sync.

```ts
// src/db-worker.ts
import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { syncDbSchema } from "./migrations";

await startDbWorker({
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new WebSocket("wss://your-server.example.com/sync"),
  }),
});
```

The `createWebSocket` factory is called each time the worker needs to establish a connection. You can use any WebSocket-compatible library (e.g., `PartySocket` for Cloudflare Workers with PartyServer).

```ts
// Using PartySocket
import { PartySocket } from "partysocket";

createRemoteSource: createWsRemoteSource({
  createWebSocket: () =>
    new PartySocket({
      host: "localhost:8787",
      party: "my-sync-server",
      room: "main",
    }),
}),
```

### 2. Initialize the Database

```ts
// src/db.ts
import { createSyncedDb } from "@sqlite-sync/core";
import { syncDbSchema } from "./migrations";

export async function initDb() {
  const worker = new Worker(
    new URL("./db-worker.ts", import.meta.url),
    { type: "module" }
  );

  const db = await createSyncedDb({
    dbId: "my-app-db",
    worker,
    syncDbSchema,
    workerProps: undefined,
  });

  return db;
}
```

**`createSyncedDb` options:**

| Option | Type | Description |
|--------|------|-------------|
| `dbId` | `string` | Unique database identifier. Must match `^[a-zA-Z][a-zA-Z\-0-9]{2,63}$`. Used for OPFS directory names and Web Lock keys. |
| `worker` | `Worker` | The Web Worker instance running `startDbWorker`. |
| `syncDbSchema` | `SyncDbSchema` | The schema built with `createSyncDbSchema`. |
| `workerProps` | `Props` | Extra data passed to the worker (accessible via `getWorkerConfig().props`). |
| `clearOnInit` | `boolean` | If `true`, wipes the OPFS database on startup. Useful for development. |

`createSyncedDb` is async — it acquires a Web Lock, initializes the worker, takes a snapshot of the persisted database, and loads it into the in-memory reactive SQLite instance.

### 3. Passing Worker Props

If you need to pass dynamic configuration to the worker (e.g., auth tokens, server URLs):

```ts
// Main thread
const db = await createSyncedDb({
  dbId: "my-db",
  worker,
  syncDbSchema,
  workerProps: { token: "abc123", serverUrl: "wss://..." },
});

// Worker file
import { getWorkerConfig, startDbWorker } from "@sqlite-sync/core/worker";

const config = await getWorkerConfig<{ token: string; serverUrl: string }>();

await startDbWorker({
  syncDbSchema,
  workerConfig: config,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () => new WebSocket(`${config.props.serverUrl}?token=${config.props.token}`),
  }),
});
```

---

## React Integration

### Creating Typed Hooks

`createDbContext` takes your schema and returns a set of typed React hooks and a provider component:

```ts
// src/db.ts
import { createDbContext } from "@sqlite-sync/react";
import { syncDbSchema } from "./migrations";

export const { DbProvider, useDb, useDbQuery, useDbState } = createDbContext(syncDbSchema);
```

All hooks are fully typed based on your schema — queries autocomplete table and column names, mutations validate payload types.

### Provider Setup

Wrap your app with `DbProvider`, passing in the initialized `SyncedDb` instance. Since `createSyncedDb` is async, use React 19's `use()` with Suspense:

```tsx
// src/main.tsx
import { Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { DbProvider, initDb } from "./db";
import { App } from "./App";

const dbPromise = initDb();

function Root({ children }: { children: React.ReactNode }) {
  const db = use(dbPromise);
  return <DbProvider db={db}>{children}</DbProvider>;
}

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<div>Loading database...</div>}>
    <Root>
      <App />
    </Root>
  </Suspense>
);
```

---

## Queries

### Live Queries with `useDbQuery`

`useDbQuery` creates a **reactive subscription** — the query re-runs automatically when underlying tables change (via SQLite update hooks). It uses `useSyncExternalStore` for concurrent-safe React integration.

**Kysely query builder (recommended):**

```tsx
import { useDbQuery } from "./db";

function TodoList() {
  const { data: todos } = useDbQuery((db) =>
    db.selectFrom("todo").selectAll().orderBy("title", "asc").limit(100)
  );

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

Queries target the **CRDT view name** (e.g., `"todo"`, not `"_todo"`). The view automatically filters out tombstoned (soft-deleted) rows.

**With dynamic parameters:**

```tsx
function FilteredTodos({ search }: { search: string }) {
  const { data: todos } = useDbQuery((db) =>
    db
      .selectFrom("todo")
      .selectAll()
      .where("title", "like", `%${search}%`)
      .limit(50)
  );
  // Re-runs when `search` changes or when the todo table is modified
  return <ul>{todos.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

When the SQL string stays the same but parameters change, the existing prepared statement is reused with the new parameters — no re-compilation overhead.

**Transforming results with `mapData`:**

```tsx
const { data: stats } = useDbQuery(
  (db) =>
    db
      .selectFrom("todo")
      .select(({ fn }) => [
        fn.countAll<number>().as("total"),
        fn.sum<number>("completed").as("completed"),
      ]),
  {
    mapData: ([row]) => ({
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
    }),
  },
);
// stats: { total: number; completed: number }
```

**Raw SQL:**

```tsx
const { data: todos } = useDbQuery({
  sql: "SELECT * FROM todo WHERE completed = ? LIMIT ?",
  parameters: [false, 100],
});
```

**Manual refresh:**

```tsx
const { data, refresh } = useDbQuery((db) =>
  db.selectFrom("todo").selectAll()
);

// Force re-fetch with new parameters
refresh([newParam1, newParam2]);
```

---

## Mutations

Mutations are performed imperatively through the `db` object returned by `useDb()`. All mutations go through **CRDT views** (e.g., `"todo"`, not `"_todo"`), which generate CRDT events via SQL triggers.

```tsx
import { useDb } from "./db";
import { generateId } from "@sqlite-sync/core";

function AddTodo() {
  const { db } = useDb();

  const handleAdd = () => {
    db.executeKysely((db) =>
      db.insertInto("todo").values({
        id: generateId(),
        title: "New todo",
        completed: false,
      })
    );
  };

  return <button onClick={handleAdd}>Add Todo</button>;
}
```

### Insert

```ts
db.executeKysely((db) =>
  db.insertInto("todo").values({
    id: generateId(),     // crypto.randomUUID()
    title: "Buy groceries",
    completed: false,
  })
);
```

You must always provide an `id` (UUID) for new items. The `tombstone` column is managed automatically — do not set it.

### Update

```ts
db.executeKysely((db) =>
  db
    .updateTable("todo")
    .set({ completed: true })
    .where("id", "=", todoId)
);
```

Only changed columns are included in the CRDT event payload. Unchanged columns are not affected on other clients.

### Delete

```ts
db.executeKysely((db) =>
  db.deleteFrom("todo").where("id", "=", todoId)
);
```

Deletes are soft-deletes — the trigger sets `tombstone = 1` via a CRDT event. The CRDT view filters out tombstoned rows automatically.

### Transactions

Batch multiple mutations in a single transaction for atomicity:

```ts
db.executeTransaction((trx) => {
  for (const item of items) {
    trx.executeKysely((db) =>
      db.insertInto("todo").values({
        id: generateId(),
        title: item.title,
        completed: false,
      })
    );
  }
});
```

All CRDT events within a transaction are generated and applied together.

### Raw SQL

```ts
db.execute({
  sql: "INSERT INTO todo (id, title, completed) VALUES (?, ?, ?)",
  parameters: [generateId(), "Raw SQL todo", false],
});

// Or as a simple string (no parameters)
db.execute("DELETE FROM todo WHERE completed = 1");
```

---

## Sync State

### Reading State

Use `useDbState` to reactively read the current sync connection state:

```tsx
import { useDbState } from "./db";

function SyncStatus() {
  const { remoteState } = useDbState();

  return (
    <span>
      {remoteState === "online" && "Connected"}
      {remoteState === "offline" && "Offline"}
      {remoteState === "pending" && "Connecting..."}
    </span>
  );
}
```

### Controlling Sync

Use `useDb()` to programmatically go online or offline:

```tsx
function SyncToggle() {
  const { state } = useDb();
  const { remoteState } = useDbState();

  return (
    <button
      onClick={() => {
        if (remoteState === "online") {
          state.goOffline();
        } else {
          state.goOnline();
        }
      }}
    >
      {remoteState === "online" ? "Go Offline" : "Go Online"}
    </button>
  );
}
```

---

## Migrations

Migrations handle schema evolution while keeping CRDT events compatible across different client versions.

### Adding Columns

```ts
const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_todo", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
  1: [
    b.addColumn({
      table: "_todo",
      column: "priority",
      type: "integer",
      defaultValue: 0,
    }),
  ],
}));
```

When a client at version 1 receives an `item-created` event from a version 0 client, the migration system automatically adds `priority: 0` to the event payload before applying it.

### Renaming Tables and Columns

```ts
2: [
  b.renameTable({ oldTable: "_todo", newTable: "_task" }),
  b.renameColumn({ table: "_task", oldColumn: "title", newColumn: "name" }),
],
```

Events referencing the old table/column names are automatically transformed when migrated.

### Dropping Columns

```ts
3: [
  b.dropColumn({ table: "_task", column: "priority" }),
],
```

The `priority` key is stripped from event payloads. If an `item-updated` event only modified `priority`, the entire event is dropped.

### Protected Columns

The `id` and `tombstone` columns cannot be renamed or dropped — they are required for CRDT operations.

---

## Server Setup

### Cloudflare Durable Object

The server uses a Cloudflare Durable Object with embedded SQLite storage. The `@sqlite-sync/cloudflare` package provides `durableObjectAdapter` which handles event storage, conflict resolution, and client synchronization.

```ts
// src/server.ts
import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { syncDbSchema } from "./migrations";

export class SyncServer extends Server<Env> {
  static options = { hibernate: true };
  private remoteHandler: RemoteHandler = null!;

  onStart(): void {
    const { remoteHandler } = durableObjectAdapter.createCrdtStorage({
      syncDbSchema,
      crdtEventsTable: "crdt_events",
      nodeId: this.ctx.id.toString(),
      storage: this.ctx.storage,
      broadcastPayload: (payload) => {
        this.broadcast(payload);
      },
    });
    this.remoteHandler = remoteHandler;
  }

  onMessage(connection: Connection, message: string) {
    const result = this.remoteHandler.handleMessage(message);
    if (!result.success) {
      console.error("Invalid sync message", result.error);
      return;
    }
    connection.send(result.payload);
  }
}

// Worker entry point
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

**`durableObjectAdapter.createCrdtStorage` options:**

| Option | Type | Description |
|--------|------|-------------|
| `syncDbSchema` | `SyncDbSchema` | Same schema used on the client. |
| `crdtEventsTable` | `string` | Name of the SQLite table for storing CRDT events (e.g., `"crdt_events"`). |
| `nodeId` | `string` | Unique ID for this server node. Typically `this.ctx.id.toString()`. Truncated to 12 chars for HLC. |
| `storage` | `DurableObjectStorage` | The Durable Object's `ctx.storage`. |
| `broadcastPayload` | `(payload: string) => void` | Callback to send a message to all connected WebSocket clients. |
| `batchSize` | `number` | Max events per pull response. Default: `50`. |

**Returns:**

```ts
{
  syncDb: ServerSyncDb<Schema>;       // Read + write + event listener
  remoteHandler: RemoteHandler;       // WebSocket message handler
}
```

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "name": "my-sync-server",
  "main": "src/server.ts",
  "compatibility_date": "2025-12-02",
  "durable_objects": {
    "bindings": [
      { "class_name": "SyncServer", "name": "SyncServer" }
    ]
  },
  "migrations": [
    { "new_sqlite_classes": ["SyncServer"], "tag": "v1" }
  ]
}
```

Use `new_sqlite_classes` (not `new_classes`) to enable the SQLite-backed Durable Objects storage API.

---

## Server-Side Mutations

The `syncDb` object returned by `durableObjectAdapter.createCrdtStorage` lets you read data and write CRDT events from the server. This is useful for server-initiated side effects like AI processing, data enrichment, or admin operations.

### Reading Data

```ts
const { rows } = syncDb.executeKysely((db) =>
  db
    .selectFrom("_item")
    .where("tombstone", "=", false)
    .where("id", "=", itemId)
    .select(["id", "title"])
);

const item = rows[0];
```

Server-side reads use the **base table name** (e.g., `"_item"`), not the CRDT view name, since CRDT views are only set up on the client.

### Writing Events

```ts
syncDb.enqueueEvent({
  type: "item-updated",
  dataset: "_item",
  item_id: itemId,
  payload: { processingStatus: "complete", tags: JSON.stringify(["action", "sci-fi"]) },
});
```

Events enqueued on the server are applied immediately and broadcast to all connected clients.

### Listening to Events

```ts
syncDb.addEventListener("event-applied", (event) => {
  const { type, dataset, item_id, payload } = event.payload;

  if (type === "item-created" && dataset === "_item") {
    // Trigger server-side processing for new items
    processNewItem(item_id);
  }
});
```

---

## Vite Configuration

sqlite-sync requires specific Vite configuration for WASM and Web Worker support:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"], // WASM must not be pre-bundled
  },
  worker: {
    format: "es", // Web Workers use ES module format
  },
  resolve: {
    conditions: ["@sqlite-sync/source"], // Resolve to .ts source in monorepo dev
  },
});
```

Key requirements:
- `@sqlite.org/sqlite-wasm` must be excluded from `optimizeDeps` — it needs to load its WASM binary at runtime.
- Workers must use `"es"` format for ES module imports.
- The `@sqlite-sync/source` condition is only needed when developing within the sqlite-sync monorepo itself. Published consumers do not need it.

---

## API Reference

### `@sqlite-sync/core`

#### `createSyncedDb(options)`

Creates and initializes a synced database instance for the browser.

```ts
function createSyncedDb<Database, Props = undefined>(
  options: SyncedDbOptions<Database, Props>
): Promise<SyncedDb<Database>>
```

**Returns `SyncedDb<Database>`:**

| Property | Type | Description |
|----------|------|-------------|
| `db.execute(params)` | `(params) => ExecuteResult<T>` | Execute raw SQL |
| `db.executeKysely(factory)` | `(factory) => ExecuteResult<T>` | Execute a Kysely query |
| `db.executeTransaction(callback)` | `(callback) => T` | Run mutations in a transaction |
| `db.createLiveQuery(query)` | `(query) => LiveQuery<T>` | Create a reactive query subscription |
| `state.getState()` | `() => WorkerState` | Get current sync state |
| `state.subscribe(onChange)` | `(fn) => () => void` | Subscribe to state changes |
| `state.goOnline()` | `() => Promise<void>` | Connect to remote server |
| `state.goOffline()` | `() => void` | Disconnect from remote server |
| `dispose()` | `() => Promise<void>` | Clean up all resources |

#### `createSyncDbSchema(options)`

Creates a schema builder for defining CRDT tables.

```ts
function createSyncDbSchema(options: { migrations: Migrations }): CrdtSchemaBuilder
```

#### `createMigrations(builder)`

Defines versioned DDL migrations.

```ts
function createMigrations(
  builder: (steps: MigrationSteps) => Record<number, MigrationStep[]>
): Migrations
```

#### `generateId()`

Generates a UUID v4 via `crypto.randomUUID()`.

### `@sqlite-sync/core/worker`

#### `startDbWorker(options)`

Entry point for the Web Worker. Initializes OPFS storage and starts sync.

```ts
function startDbWorker(options: {
  syncDbSchema: SyncDbSchema;
  createRemoteSource?: CreateRemoteSourceFactory;
  logger?: Logger;
  workerConfig?: WorkerConfig;
}): Promise<void>
```

#### `getWorkerConfig<Props>()`

Retrieves the configuration sent from the main thread. Call this before `startDbWorker` if you need to access `workerProps`.

```ts
function getWorkerConfig<Props>(): Promise<WorkerConfig<Props>>

type WorkerConfig<Props> = {
  dbId: string;
  clientId: string;
  clearOnInit?: boolean;
  props: Props;
}
```

#### `createWsRemoteSource(options)`

Creates a WebSocket-based remote sync source for the worker.

```ts
function createWsRemoteSource(options: {
  createWebSocket: () => WebSocket;
}): CreateRemoteSourceFactory
```

### `@sqlite-sync/react`

#### `createDbContext(schema)`

Creates typed React hooks and a provider component from your schema.

```ts
function createDbContext<Schema extends SyncDbSchema>(schema: Schema): {
  DbProvider: React.FC<{ children: React.ReactNode; db: SyncedDb<Schema["~clientSchema"]> }>;
  useDb: () => SyncedDb<Schema["~clientSchema"]>;
  useDbQuery: <TResult, TMapResult = TResult[]>(
    query: DbQueryParams<Schema["~clientSchema"], TResult>,
    options?: { mapData?: (data: TResult[]) => TMapResult }
  ) => { data: TMapResult; refresh: (parameters?: readonly unknown[]) => void };
  useDbState: () => WorkerState;
}
```

### `@sqlite-sync/cloudflare`

#### `durableObjectAdapter.createCrdtStorage(options)`

Sets up CRDT storage inside a Cloudflare Durable Object.

```ts
function createCrdtStorage<Schema extends SyncDbSchema>(options: {
  storage: DurableObjectStorage;
  syncDbSchema: Schema;
  nodeId: string;
  crdtEventsTable: string;
  batchSize?: number;
  broadcastPayload: (payload: string) => void;
}): {
  syncDb: ServerSyncDb<Schema>;
  remoteHandler: RemoteHandler;
}
```

**`ServerSyncDb<Schema>`:**

| Method | Description |
|--------|-------------|
| `execute(params)` | Execute raw SQL |
| `executeKysely(factory)` | Execute a typed Kysely query |
| `enqueueEvent(event)` | Write a single CRDT event |
| `enqueueEvents(events)` | Write multiple CRDT events |
| `createEvent(event)` | Type helper — returns the event as-is |
| `addEventListener("event-applied", handler)` | Listen for applied events |

**`RemoteHandler`:**

| Method | Description |
|--------|-------------|
| `handleMessage(message: string)` | Parse and handle a WebSocket message. Returns `{ success: true, payload: string }` or `{ success: false, error: unknown }`. |

#### `createKyselyExecutor(storage)`

Low-level typed SQL executor wrapping Durable Object storage. Used internally by `durableObjectAdapter` but available for direct use.

```ts
function createKyselyExecutor<TDatabase>(
  storage: DurableObjectStorage
): KyselyExecutor<TDatabase>
```

#### `createMigrator(kv, executor, migrations)`

Creates a migration runner for Durable Object storage.

```ts
function createMigrator(
  kv: SyncKvStorage,
  executor: KyselyExecutor<any>,
  migrations: Migrations,
  updateLogTableName?: string
): SyncDbMigrator
```

#### `do-jobs`

SQLite-backed background jobs for Durable Objects with alarm-based execution.

```ts
import { createDefineJob, setupJobs, type JobRuntime } from "do-jobs";
import { z } from "zod";

type JobContext = { ctx: DurableObjectState; env: Env };
const defineJob = createDefineJob<JobContext>();

const exampleJob = defineJob({ type: "example" })
  .input(z.object({ world: z.string() }))
  .handler(async ({ input, context }) => {
    console.log("hello", input.world, context.env);
  });

let jobs: JobRuntime;

async function onStart(ctx: DurableObjectState, env: Env) {
  jobs = await setupJobs({
    jobs: [exampleJob],
    ctx,
    context: { ctx, env },
  });
}

function onAlarm() {
  return jobs.onAlarm();
}

// Schedule a one-off job
await jobs.schedule(exampleJob, { input: { world: "earth" }, at: Date.now() + 1000 });
```

**Job APIs**

| Method | Description |
|--------|-------------|
| `createDefineJob<TContext>()` | Create a typed `defineJob` factory bound to a context shape. |
| `defineJob({ type }).input(schema).handler(fn)` | Define a typed job handler. Handler receives `{ input, context, job }`. |
| `setupJobs({ jobs, ctx, context, maxJobsPerAlarm? })` | Initialize schema/alarms and create runtime. `context` is passed to handlers. |
| `jobs.schedule(job, { input, at })` | Enqueue one-off run at a timestamp. Always inserts a new row. |
| `jobs.scheduleInterval(job, { input, dedupeKey, everyMs, startAt? })` | Upsert recurring schedule by `(type, dedupeKey)`. |
| `jobs.cancelInterval(job, { dedupeKey })` | Cancel active recurring schedule for that key. |

**Execution semantics**

- Due jobs are processed serially in FIFO order by `scheduledAt`.
- No automatic retries on failure.
- Interval schedules use fixed-delay (`nextRunAt = now + everyMs`).
- Missed interval ticks are coalesced into one run after wake-up.
- Job history is retained in SQLite tables.

### WebSocket Protocol

The sync protocol uses JSON messages over WebSocket.

**Client → Server:**

```ts
// Pull events since a given sync ID
{ type: "pull-events", requestId: string, afterSyncId: number, excludeNodeId?: string }

// Push new events to the server
{ type: "push-events", requestId: string, nodeId: string, events: CrdtEvent[] }
```

**Server → Client:**

```ts
// Response to pull-events
{ type: "events-pull-response", requestId: string, data: { events: CrdtEvent[], hasMore: boolean, nextSyncId: number } }

// Response to push-events
{ type: "events-push-response", requestId: string, data: { ok: true } }

// Server push notification when new events are available
{ type: "events-applied", newSyncId: number }
```
