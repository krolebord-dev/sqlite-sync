# sqlite-sync Documentation

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT support for local-first applications. All writes happen locally against an in-memory SQLite database, persist to OPFS via a Web Worker, and sync automatically to a remote server over WebSocket.

## Table of Contents

- [Installation](#installation)
- [Architecture Overview](#architecture-overview)
- [Schema Definition](#schema-definition)
- [Client Setup](#client-setup)
- [React Integration](#react-integration)
- [Devtools](#devtools)
- [Server Setup](#server-setup)
- [Queries](#queries)
- [Mutations](#mutations)
- [Backup and Restore](#backup-and-restore)
- [Sync State](#sync-state)
- [Migrations](#migrations)
- [Server-Side Mutations](#server-side-mutations)
- [AI Agent Tools](#ai-agent-tools)
- [Vite Configuration](#vite-configuration)
- [API Reference](#api-reference)

---

## Installation

```bash
# Core sync engine
pnpm add @sqlite-sync/core

# React bindings
pnpm add @sqlite-sync/react

# Optional: floating browser devtools UI
pnpm add @sqlite-sync/devtools

# Cloudflare Durable Objects adapter (server)
pnpm add @sqlite-sync/cloudflare

# AI agent tools (server)
pnpm add @sqlite-sync/ai
```

Peer dependencies:

| Package | Peers |
|---------|-------|
| `@sqlite-sync/core` | `@sqlite.org/sqlite-wasm`, `kysely` |
| `@sqlite-sync/react` | `@sqlite-sync/core`, `react ^18 \|\| ^19`, `kysely` |
| `@sqlite-sync/devtools` | `@sqlite-sync/core`, `react ^18 \|\| ^19` |
| `@sqlite-sync/cloudflare` | `@sqlite-sync/core`, `@cloudflare/workers-types`, `kysely` |
| `@sqlite-sync/ai` | `@sqlite-sync/core`, `ai ^6` |

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
- An event **type**: `item-created`, `item-updated`, or `item-deleted`. Deletes are soft-deletes — `item-deleted` events carry no field data on the wire, and the receiver materializes them by setting `tombstone = 1`.

Events are conflict-free — concurrent edits to different columns merge automatically, and concurrent edits to the same column resolve via last-write-wins using HLC comparison.

---

## Schema Definition

A schema defines your CRDT-enabled tables and their migrations. The schema is shared between client and server.

### Defining Migrations

Use `createMigrations` to define versioned DDL operations:

```ts
// src/migrations.ts
import { createMigrations } from "@sqlite-sync/core";

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
- A `tombstone` column of type `boolean` or `integer` (soft-delete flag, compared as 0/1)

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

Declare tables with the `t.*` column builders and tie them to the migrations with `defineSyncSchema`.
Record keys are the CRDT (view) table names; the base table name defaults to the key with an
underscore prefix (override per table with `t.table(cols, { baseName })`). The `id` and `tombstone`
columns are added automatically and must not be declared.

```ts
import { defineSyncSchema, t } from "@sqlite-sync/core";

export const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t
      .table({
        title: t.text().describe("Todo title."),
        completed: t.boolean().default(false).describe("1 when done."),
        priority: t.integer().default(0),
      })
      .describe("The user's todos."),
    tag: t.table({
      name: t.text(),
    }),
  },
  migrations,
});

// Row types are inferred from the declarations:
export type Todo = typeof syncDbSchema.tables.todo.$row;
```

Column builders: `t.text()`, `t.integer()`, `t.real()`, `t.boolean()` (stored as INTEGER 0/1),
and `t.enum(["a", "b"])` (TEXT, validated against the values at runtime — no SQL CHECK
constraint). JSON values are stored as serialized TEXT via `t.text()` — parse at the call site.
Each column builder chains `.nullable()`, `.default(value)`,
`.$type<Narrowed>()` (type-only narrowing, e.g. `t.text().$type<"a" | (string & {})>()`), and
`.describe(text)` for generated schema docs. Table builders also chain `.describe(text)`.

The table builders also expose runtime metadata: `syncDbSchema.tables.todo.columns` (per-column
kind, nullability, defaults) and `validatePayload(payload, { event })` for checking CRDT event
payloads against the declared columns.

### Verifying Migrations Against the Schema

Migrations are hand-written and can drift from the declared tables. `verifySyncSchema` replays the
full migration history on a throwaway in-memory database and diffs the result against the
declarations — missing/extra columns, type and nullability mismatches, wrong defaults, and a
missing `id` primary key are reported as structured issues. Tables created by migrations but not
declared (e.g. local-only caches) are ignored.

```ts
// Vitest one-liner:
it("migrations produce the declared schema", async () => {
  expect(await verifySyncSchema(syncDbSchema)).toEqual([]);
});
```

In the browser, pass `verifySchema: import.meta.env.DEV` to `startDbWorker` — on mismatch the
worker throws with the full issue list and refuses to start.

The schema carries three phantom types used for type inference:
- `~clientSchema` — Used by React hooks. Includes both base tables (read-only) and CRDT views (read-write).
- `~serverSchema` — Used by server-side `executeKysely`. Includes both base tables and read-only CRDT views.
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
| `syncDbSchema` | `SyncDbSchema` | The schema built with `defineSyncSchema`. |
| `workerProps` | `Props` | Extra data passed to the worker (accessible via `getWorkerConfig().props`). |

To wipe the local database (e.g. during development or as a recovery path), use `syncedDb.requestReload({ clean: true })` — see [Reload and Recovery](#reload-and-recovery).

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

export const { DbProvider, useDb, useDbQuery, useDbState, useDbEvent } = createDbContext(syncDbSchema);
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

Identical `useDbQuery` calls within the same `DbProvider` reuse the same live query when both the SQL string and parameter values match. Each component still receives its own `mapData` result, but the underlying live subscription is shared.

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

When the SQL string stays the same but parameters change, the prepared statement is reused with the new parameters — no re-compilation overhead. If both SQL and parameter values stay the same, React consumers also share the same live query subscription.

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

// Force re-fetch for the current query
refresh();
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

Deletes are soft-deletes — the trigger emits an `item-deleted` CRDT event, and applying that event sets `tombstone = 1`. The CRDT view filters out tombstoned rows automatically.

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

## Backup and Restore

`syncedDb.exportData()` and `syncedDb.importData()` move the database's current
data in and out as a portable JSON envelope. This is for **backup, seed, and
restore** — distinct from a raw SQLite snapshot, the export carries no event
history, just the current active rows of every synced table.

```ts
const dump = syncedDb.exportData();
// {
//   schemaVersion: 3,
//   exportedAt: "2026-06-16T12:00:00.000Z",
//   tables: { todo: [{ id: "1", title: "buy milk", completed: 0 }, ...] },
// }

// later, on a fresh or different database:
const { imported } = syncedDb.importData(dump);
```

`exportData(opts?)` dumps every active (`tombstone = 0`) row from each synced
table, keyed by table name. Each row keeps its `id` and drops the internal
`tombstone` column. Pass `{ tables: ["todo"] }` to export a subset. The data is
read from the local in-memory database — the state the current tab sees.

`importData(data, opts?)` replays each row as an `item-created` CRDT event,
seeding it into local state and propagating to the server like any other write.
Because the generated events get fresh timestamps:

- **New ids are inserted; existing ids are overwritten** field-by-field under
  last-write-wins. Rows not present in the dump are left untouched.
- It is a restore/seed, **not a CRDT merge** — original timestamps are not
  preserved, so imported data always wins against pre-existing local state.

Import rejects a dump whose `schemaVersion` differs from the current database
(no cross-version migration); pass `{ validate: false }` to skip that check. Row
payloads are always validated against the schema and the import is atomic — an
invalid row throws `CrdtEventValidationError` and applies nothing.

---

## Devtools

`@sqlite-sync/devtools` provides a floating in-app debug UI for browser apps using `createSyncedDb()`.

### Mounting the Devtools

Render `SQLiteSyncDevtools` once near the root of your app:

```tsx
import { SQLiteSyncDevtools } from "@sqlite-sync/devtools";

function Root({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <SQLiteSyncDevtools />
    </>
  );
}
```

The component renders a floating `SQLite Sync` button. Clicking it opens a dialog with:
- a left sidebar for navigation and database selection
- a main pane for the active tool

### Instance Discovery

Synced database instances register automatically when `createSyncedDb()` finishes initialization and unregister automatically when `dispose()` is called.

You do not need to pass instances manually to the devtools component. Mounting `SQLiteSyncDevtools` is enough, as long as your app creates databases through `createSyncedDb()`.

### Current Tools

The current devtools prototype includes:
- an overview tab for selecting a detected database
- a query runner tab for executing SQL against the selected instance

### Query Runner Rules

The query runner currently enforces the following rules:
- **Worker DB** queries are read-only. Only `SELECT`, `PRAGMA`, and `EXPLAIN` are allowed.
- **Memory DB** queries may read any table, but writes are only allowed when every written table is a configured CRDT table.
- Only a single SQL statement is executed at a time.
- Results and errors are shown as raw JSON.

These constraints are intentional for the current prototype so that devtools can inspect live databases without bypassing sqlite-sync’s CRDT write path.

---

## Sync State

### Reading State

Use `useDbState` to reactively read the current sync connection state:

```tsx
import { useDbState } from "./db";

function SyncStatus() {
  const { remoteState, deSynced, schemaVersionMismatched } = useDbState();

  return (
    <span>
      {remoteState === "online" && "Connected"}
      {remoteState === "offline" && "Offline"}
      {remoteState === "pending" && "Connecting..."}
      {schemaVersionMismatched && "New version available"}
      {deSynced && "Local data out of sync"}
    </span>
  );
}
```

`useDbState()` returns:

| Field | Type | Description |
|-------|------|-------------|
| `remoteState` | `"online" \| "offline" \| "pending"` | Current remote connection state. |
| `deSynced` | `boolean` | `true` after the worker detects that local applied events and remote applied events diverged. |
| `schemaVersionMismatched` | `boolean` | `true` after the worker receives an event from a newer schema version than the local code can apply. |

### De-sync and Schema Mismatch

sqlite-sync detects two recovery conditions while syncing:

- **De-sync detected** — the local worker is caught up to the remote sync ID and no local events are waiting to push, but the local and remote HLC checksums differ. This means the applied event sets have diverged. It can also be raised if applying a remote event fails.
- **Schema version mismatch** — the remote sends an event with a `schema_version` greater than the local migrator's current schema version. This usually means another client has already written data with newer app code.

You can react to these conditions through `useDbState()` for UI state, or subscribe to the underlying worker notifications with `useDbEvent()`:

```tsx
function SyncStatusMonitor() {
  const db = useDb();

  useDbEvent("remote-schema-version-mismatch", () => {
    showPersistentPrompt({
      title: "A new version is available",
      description: "Reload to update before syncing new changes.",
      actionLabel: "Reload",
      action: () => db.requestReload({ clean: false }),
    });
  });

  useDbEvent("de-sync-detected", () => {
    showPersistentPrompt({
      title: "Your local data is out of sync",
      description: "Reload and reset local data to re-sync from the server.",
      actionLabel: "Reload and reset",
      action: () => db.requestReload({ clean: true }),
    });
  });

  return null;
}
```

Prompt the user before calling `requestReload`. Both recovery paths can reload every open tab for the same `dbId`; the clean recovery path also wipes the persisted local worker DB on next startup.

Use `requestReload({ clean: false })` for schema mismatch first: it reloads all tabs for the `dbId` without wiping the persisted worker DB, letting the app load newer code and migrations. If the user is already on the latest code and the mismatch persists, deploy compatibility migrations or treat it as a recovery incident.

Use `requestReload({ clean: true })` for de-sync recovery: it records a reset request, reloads all tabs for the `dbId`, wipes the persisted worker DB on the next worker startup, and rehydrates from the remote event log. This is destructive to pending in-memory tab events and any local-only durable events that had not reached the remote.

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

### Reload and Recovery

Use `requestReload` to ask the elected worker to broadcast a page reload to all tabs for the same `dbId`:

```ts
// Process-level reconnect: reloads all tabs, keeps the persisted worker DB.
await syncedDb.requestReload({ clean: false });

// Destructive recovery: reloads all tabs and wipes the persisted worker DB
// on the next startup. Use when the local worker DB may be de-synced.
await syncedDb.requestReload({ clean: true });
```

Notes:

- This is a recovery/reload flow, not a hot runtime reset — pending in-memory tab events are not preserved.
- The returned promise may never settle in the caller: the page typically unloads first.
- For `clean: true`, the worker durably records a reset request epoch (in IndexedDB) before broadcasting. Whichever worker wins the post-reload election applies the wipe exactly once; the request expires after 10 minutes if the reload never happens.

### Breaking Storage Changes

To deploy a code change that old persisted local DBs cannot survive, bump `storageVersion` in `startDbWorker`:

```ts
await startDbWorker({
  syncDbSchema,
  storageVersion: "2",
  // ...
});
```

The worker durably stores the combined version (app version + internal library storage version). When the elected worker starts with a version that does not match the stored one, it wipes the local DB during initialization and records the new version after a successful init. Clients on the old version are unaffected until they load the new code.

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

  async onStart() {
    const { remoteHandler } = await durableObjectAdapter.createCrdtStorage({
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
    .selectFrom("item")
    .where("id", "=", itemId)
    .select(["id", "title"])
);

const item = rows[0];
```

Server-side reads can use the read-only **CRDT view name** (e.g., `"item"`). The Durable Object adapter creates these views from the schema and filters out tombstoned rows automatically. Writes still go through CRDT events, not SQL writes to the view.

### Writing Events

```ts
syncDb.enqueueEvent({
  type: "item-updated",
  dataset: "_item",
  item_id: itemId,
  payload: { processingStatus: "complete", tags: JSON.stringify(["action", "sci-fi"]) },
});
```

To delete from the server, enqueue an `item-deleted` event. The payload is omitted because the tombstone is materialized when the event is applied:

```ts
syncDb.enqueueEvent({
  type: "item-deleted",
  dataset: "_item",
  item_id: itemId,
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

## AI Agent Tools

`@sqlite-sync/ai` exposes a synced database to an AI SDK (v6) agent. Create the access object where the CRDT storage lives (e.g. a Durable Object's `onStart`, after migrations), then hand the agent a `ToolSet`:

```ts
import { createAiDbAccess, createDbTools } from "@sqlite-sync/ai";
import { createKyselyExecutor } from "@sqlite-sync/cloudflare";

// Next to the storage:
const aiDbAccess = createAiDbAccess({
  executor: createKyselyExecutor(this.ctx.storage),
  syncDbSchema,
  context: {
    overview: "# My app's database\n\nDeletes are soft-deletes; the views below already hide them.",
  },
});

// In the agent:
const tools = createDbTools({ access: () => aiDbAccess });
```

The schema doc is generated from the declared sync schema's table builders (including table/column `.describe()` descriptions and enum values) plus the app-provided `context.overview` — no database access involved. For cross-Durable-Object setups, `AiDbAccess` method names double as the RPC contract — a stub proxying `getSchemaDoc()` and `query()` satisfies `createDbTools`. The default `ToolSet` contains `getDbSchema` and `queryDb`.

To allow AI writes, pass the CRDT storage to `createAiDbAccess` and opt in when creating tools:

```ts
const aiDbAccess = createAiDbAccess({
  executor: createKyselyExecutor(this.ctx.storage),
  storage: crdtStorage,
  syncDbSchema,
});

const tools = createDbTools({ access: () => aiDbAccess, mutations: true });
```

This adds `mutateDb`, which accepts `item-created`, `item-updated`, and `item-deleted` CRDT events. It applies them through sqlite-sync's own-event path, not arbitrary write SQL, so writes are validated, persisted to the event log, applied locally, and synced normally. For `item-created` events, omit `item_id` and `payload.id`; the tool generates ids, injects them into the CRDT events, and returns them as `createdIds`.

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
| `subscribe(type, handler)` | `(type, handler) => { unsubscribe: () => void }` | Subscribe to worker notifications such as `de-sync-detected` and `remote-schema-version-mismatch` |
| `requestReload(options)` | `(options: { clean: boolean }) => Promise<void>` | Reload all tabs for this `dbId`; `clean: true` also wipes the persisted worker DB on next startup |
| `dispose()` | `() => Promise<void>` | Clean up all resources |

#### `defineSyncSchema(config)`

Defines the sync database schema from `t.table()` builders plus the migration history.

```ts
function defineSyncSchema<Tables extends SyncSchemaTables>(config: {
  tables: Tables;
  migrations: Migrations;
}): DefinedSyncSchema<Tables>
```

#### `verifySyncSchema(schema)`

Replays the migration history on a throwaway in-memory database and diffs the result
against the declared tables. Resolves with an empty array when they agree.

```ts
function verifySyncSchema(schema: SyncDbSchema): Promise<SchemaVerificationIssue[]>
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
  storageVersion?: string;
  /** Dev-time drift check — throws and refuses to start on schema/migration mismatch. */
  verifySchema?: boolean;
  /** Local worker event-log garbage collection. Disabled by default. */
  eventLogGc?: boolean;
}): Promise<void>
```

`storageVersion` is an app-provided storage version, combined with the library's internal storage version. Bump it when deploying a code change that old persisted local DBs cannot survive — on mismatch, the elected worker wipes the local DB on startup (a full re-sync follows, like `requestReload({ clean: true })`).

`eventLogGc` controls startup-only worker event-log garbage collection. It is disabled by default. GC keeps at least the latest 100 applied/deduped event rows, never deletes pending rows, and never deletes local rows that have not been pushed to the remote. Set `eventLogGc: true` to enable it.

#### `getWorkerConfig<Props>()`

Retrieves the configuration sent from the main thread. Call this before `startDbWorker` if you need to access `workerProps`.

```ts
function getWorkerConfig<Props>(): Promise<WorkerConfig<Props>>

type WorkerConfig<Props> = {
  dbId: string;
  clientId: string;
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
  ) => { data: TMapResult; refresh: () => void };
  useDbState: () => WorkerState;
  useDbEvent: <EventName extends DbEventName>(
    eventName: EventName,
    handler: (event: TypedEvent<DbEventMap[EventName]>) => void
  ) => void;
}
```

### `@sqlite-sync/devtools`

#### `SQLiteSyncDevtools`

Renders a floating browser devtools button and dialog for databases created with `createSyncedDb()`.

```tsx
function SQLiteSyncDevtools(props?: { className?: string }): React.ReactElement
```

Behavior:
- auto-discovers currently registered `SyncedDb` instances
- updates when instances are created or disposed
- provides a sidebar-based dialog UI
- includes the prototype query runner described above

### `@sqlite-sync/cloudflare`

#### `durableObjectAdapter.createCrdtStorage(options)`

Sets up CRDT storage inside a Cloudflare Durable Object.

After running your schema migrations, the adapter recreates read-only CRDT views for each configured table. Each view uses the configured CRDT table name and selects non-tombstoned rows from the base table.

```ts
function createCrdtStorage<Schema extends SyncDbSchema>(options: {
  storage: DurableObjectStorage;
  syncDbSchema: Schema;
  nodeId: string;
  crdtEventsTable: string;
  batchSize?: number;
  broadcastPayload: (payload: string) => void;
}): Promise<{
  syncDb: ServerSyncDb<Schema>;
  remoteHandler: RemoteHandler;
}>
```

**`ServerSyncDb<Schema>`:**

| Method | Description |
|--------|-------------|
| `execute(params)` | Execute raw SQL |
| `executeKysely(factory)` | Execute a typed Kysely query |
| `enqueueEvent(event)` | Write a single CRDT event |
| `enqueueEvents(events)` | Write multiple CRDT events |
| `applyOwnEvents(events)` | Validate, persist, and immediately apply own CRDT events |
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

### `@sqlite-sync/ai`

#### `createAiDbAccess(options)`

Creates AI access to a synced database. Query access is read-only; mutation access is present only when a CRDT storage is provided. Lives where the storage lives; the schema doc is generated once from the declared schema.

```ts
function createAiDbAccess(options: {
  executor: AiDbExecutor; // satisfied by createKyselyExecutor from @sqlite-sync/cloudflare
  storage?: Pick<CrdtStorage, "applyOwnEvents">; // enables mutate(input)
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext; // overview/app-level notes
}): AiDbAccess // { getSchemaDoc(): string; query(input): AiQueryResult; mutate?(input): AiMutationResult }
```

#### `createDbTools(options)`

Builds an AI SDK v6 `ToolSet` backed by an `AiDbAccess` (or a stub proxying to one). `access` is a factory because acquiring the database may itself be async per call.

```ts
function createDbTools(options: {
  access: () => DbToolsAccess | Promise<DbToolsAccess>;
  mutations?: boolean; // expose mutateDb
}): ToolSet
```

#### `createSchemaDoc(options)`

Lower-level helper that generates the markdown schema doc directly from a `syncDbSchema` (and optional `context`) — used internally by `createAiDbAccess`.

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
{ type: "events-push-response", requestId: string, data: { ok: true, beforeSyncId: number, afterSyncId: number } }

// Server push notification when new events are available
{ type: "events-applied", newSyncId: number, eventHlcSum: string | null }
```
