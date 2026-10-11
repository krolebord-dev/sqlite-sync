# sqlite-sync Documentation

**sqlite-sync** is an offline-first SQLite synchronization library with CRDT support for local-first applications. All writes happen locally against an in-memory SQLite database, persist to OPFS via a Web Worker, and sync automatically to a remote server over WebSocket.

## Table of Contents

- [Installation](#installation)
- [Architecture Overview](#architecture-overview)
- [Schema Definition](#schema-definition)
- [Client Setup](#client-setup)
- [React Integration](#react-integration)
- [Queries](#queries)
- [Mutations](#mutations)
- [Backup and Restore](#backup-and-restore)
- [Devtools](#devtools)
- [Sync State](#sync-state)
- [Server Setup](#server-setup)
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

### How Migrations Transform Events

Clients on different schema versions keep syncing: each migration step also transforms CRDT events written at older versions as they are applied.

- `addColumn` — an `item-created` event from an older client gets the new column's default (`priority: 0` above).
- `renameTable` / `renameColumn` — event datasets and payload keys are rewritten to the new names.
- `dropColumn` — the key is stripped from payloads. An `item-updated` event that only changed that column is dropped.
- `dropTable` — events for the table are dropped.

The `id` and `tombstone` columns cannot be renamed or dropped.

### Building the Schema

Declare tables with the `t.*` column builders and tie them to the migrations with `defineSyncSchema`.
Record keys are the CRDT (view) table names; the base table name defaults to the key with an
underscore prefix (override per table with `t.table(cols, { baseName })`). The `id` and `tombstone`
columns are added automatically and must not be declared.

```ts
// src/db-schema.ts
import { defineSyncSchema, t } from "@sqlite-sync/core";
import { migrations } from "./migrations";

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
and `t.enum(["a", "b"])` (TEXT, validated against the values at runtime, no SQL CHECK
constraint). JSON values are stored as serialized TEXT via `t.text()`. Parse at the call site.
Each column builder chains `.nullable()`, `.default(value)`,
`.$type<Narrowed>()` (type-only narrowing, e.g. `t.text().$type<"a" | (string & {})>()`), and
`.describe(text)` for generated schema docs.

Table options cover `baseName`, `description`, `ai`, `writes`, and `exportImport`.
Defaults are `ai: "read-write"`, `writes: "any"`, and `exportImport: "include"`. See
[AI access control](#limiting-what-an-agent-may-touch) and
[Server-only tables](#server-only-tables). `.describe()` is the same as `{ description }`.

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

---

## Client Setup

### 1. Create the Web Worker

The worker is a separate file that calls `startDbWorker`. It handles OPFS persistence and remote sync.

```ts
// src/db-worker.ts
import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { syncDbSchema } from "./db-schema";

await startDbWorker({
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new WebSocket("wss://your-server.example.com/sync"),
  }),
});
```

The `createWebSocket` factory is called for each connection attempt. The library reconnects on its own with backoff, so a plain `WebSocket` is enough. With PartyServer on Cloudflare, connect to the route `routePartykitRequest` serves (`/parties/<party>/<room>` by default):

```ts
const syncUrl = new URL("/parties/my-sync-server/main", "https://your-server.example.com");
syncUrl.protocol = syncUrl.protocol === "https:" ? "wss:" : "ws:";

createRemoteSource: createWsRemoteSource({
  createWebSocket: () => new WebSocket(syncUrl),
}),
```

Any WebSocket-compatible object works, including `PartySocket`. The library closes the socket when the connection drops, which also stops PartySocket's own reconnect.

### 2. Initialize the Database

```ts
// src/db.ts
import { createSyncedDb } from "@sqlite-sync/core";
import { syncDbSchema } from "./db-schema";

export async function initDb() {
  const worker = new Worker(
    new URL("./db-worker.ts", import.meta.url),
    { type: "module" }
  );

  const db = await createSyncedDb({
    dbId: "my-app-db",
    worker,
    syncDbSchema,
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
| `workerProps` | `Props` | Extra data passed to the worker (accessible via `getWorkerConfig().props`). Optional unless `Props` excludes `undefined`. |

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
import { syncDbSchema } from "./db-schema";

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

When the SQL string stays the same but parameters change, the prepared statement is reused with the new parameters — no re-compilation overhead.

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

Mutations are performed imperatively through `db` (from `const { db } = useDb()` in React, or `syncedDb.db`). All mutations go through **CRDT views** (e.g., `"todo"`, not `"_todo"`), which generate CRDT events via SQL triggers.

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
A NOT NULL column left out of the insert is left out of the event too, and each replica fills it with its table default, so defaults must be constants.

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

Each `execute` call accepts one SQL statement. Use `executeTransaction` to run multiple statements atomically.

### Unsafe SQL

Normal `execute` and `executeKysely` calls drain CRDT change intents before their statement commits. Low-level database
maintenance and recovery tooling can explicitly bypass that behavior through `unsafe`:

```ts
db.unsafe.execute({
  sql: "UPDATE _todo SET title = ? WHERE id = ?",
  parameters: ["Recovered title", todoId],
});
```

`unsafe` is also available inside transactions as `trx.unsafe`. Never use it to mutate a synced CRDT view: doing so can
leave undrained intents and will not produce a correctly synchronized mutation.

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
//   tables: { _todo: [{ id: "1", title: "buy milk", completed: 0 }, ...] },
// }

// later, on a fresh or different database:
const { imported } = await syncedDb.importData(dump);
```

`exportData(opts?)` dumps every active (`tombstone = 0`) row from each synced
table, keyed by its base table name (`_todo` for the `todo` table). Each row
keeps its `id` and drops the internal `tombstone` column. Pass `{ tables: ["todo"] }`
to export a subset — the filter accepts either the public or the base table
name. The data is read from the local in-memory database — the state the current
tab sees.

Pass `{ exportImport: "ignore" }` as a table option for data that must stay out
of backup and restore. Ignored tables are omitted even when selected explicitly,
and matching rows in an imported dump are skipped.

```ts
const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
    session: t.table({ token: t.text() }, { exportImport: "ignore" }),
  },
  migrations,
});
```

`importData(data, opts?)` replays each row as an `item-created` CRDT event,
seeding it through the worker and propagating to the server like any other write.
Because the generated events get fresh timestamps:

- **New ids are inserted; existing ids are overwritten** field-by-field under
  last-write-wins. Rows not present in the dump are left untouched.
- It is a restore/seed, **not a CRDT merge** — original timestamps are not
  preserved, so imported data always wins against pre-existing local state.

A dump from an **older** `schemaVersion` is forward-migrated up to the current
database version before being applied — the same event transformers used during
sync run here, so an old backup restores cleanly into an upgraded app (new-column
defaults are filled, rows in dropped tables are discarded). A dump from a **newer**
version cannot be down-migrated and is rejected; pass `{ validate: false }` to
author it as-is at the current version anyway (footgun — payloads are not
down-migrated). Row payloads are always validated against the schema and the
import is atomic — an invalid row rejects the call and applies nothing. The
validation runs in the worker, so `syncedDb.importData` rejects with a plain
`Error` carrying the validation message, not a `CrdtEventValidationError`.

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

A `SQLite Sync` button floats over the app. Click it and you get a dialog: sidebar on the left, the active tool on the right. The UI is isolated in a shadow root, so Tailwind (or any other host CSS) does not restyle the launcher or dialog. `className` styles the light-DOM host element only. It cannot reach internals.

If your app has its own toggle, pass `hidden` and `onHiddenChange`:

```tsx
<SQLiteSyncDevtools hidden={devtoolsHidden} onHiddenChange={setDevtoolsHidden} />
```

Leave those off if the button should manage itself: `Ctrl+Alt+S` (⌘⌥S on macOS) or Hide in the dialog toggles it, and the choice sticks in `localStorage`. The shortcut also works when you pass `onHiddenChange`.

Databases register when `createSyncedDb()` finishes initialization and unregister on `dispose()`, so there is nothing to pass in.

### Current Tools

Tabs:

- Overview: instance details, memory and worker DB sizes, CRDT event counts by status (pending, applied, failed, deduped), backup and reset
- Schema: declared tables (columns, descriptions, write/AI/export policy) and the applied migration version
- Live queries
- Event log: filters plus the matching total
- Query runner

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
      {remoteState === "connecting" && "Connecting..."}
      {schemaVersionMismatched && "New version available"}
      {deSynced && "Local data out of sync"}
    </span>
  );
}
```

`useDbState()` returns:

| Field | Type | Description |
|-------|------|-------------|
| `remoteState` | `"online" \| "offline" \| "connecting"` | Current remote connection state, described below. |
| `deSynced` | `boolean` | `true` after the worker detects that local applied events and remote applied events diverged. Stays `true` until the page reloads, since reconnecting does not fix the divergence. |
| `schemaVersionMismatched` | `boolean` | `true` after the worker receives an event from a newer schema version than the local code can apply. |

`remoteState` values:

- `online` — the remote answered a request on the current connection.
- `connecting` — the library is reconnecting on its own: an attempt is in progress, or a retry is scheduled after a dropped connection or a failed request. Retries back off exponentially (about 1s doubling up to 30s, with jitter). `goOnline()` and `state.sync()` restart the backoff.
- `offline` — nothing happens until something triggers a reconnect. That is the case after `goOffline()`, a schema version mismatch, the browser's `offline` event (the library reconnects on its `online` event), or the remote rejecting pushed events (the same batch would be rejected again, so the library waits for the next `state.sync()`).

### De-sync and Schema Mismatch

sqlite-sync detects two recovery conditions while syncing:

- **De-sync detected** — the local worker is caught up to the remote sync ID and no local events are waiting to push, but the local and remote HLC checksums differ. This means the applied event sets have diverged, for example because the server rejected some of this client's pushed events (see [Client push validation](#client-push-validation)). It can also be raised if applying a remote event fails.
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

Prompt the user before calling `requestReload` — it reloads every open tab for the `dbId` (see [Reload and Recovery](#reload-and-recovery)).

- **Schema mismatch:** use `clean: false` so the app loads newer code and migrations while keeping the persisted worker DB. If the mismatch persists on the latest code, deploy compatibility migrations or treat it as a recovery incident.
- **De-sync:** sqlite-sync only reports it and does not recover on its own, so apps need a `de-sync-detected` handler. Use `clean: true` to wipe the persisted worker DB and rehydrate from the remote event log. Pending in-memory tab events and local events that never reached the remote are lost.

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

`state.sync()` pulls new remote events and pushes pending local ones in the background, and returns immediately. New data reaches the tab like any other remote change, and failures show up as `remoteState` leaving `online`. It runs automatically whenever the page becomes visible or the browser comes back online. While `connecting`, or `offline` after a network loss or a rejected push, it reconnects right away. After `goOffline()` or a schema version mismatch it does nothing; call `goOnline()` instead.

### Reload and Recovery

`requestReload({ clean })` asks the elected worker to reload every tab for the same `dbId`. With `clean: true`, the persisted worker DB is also wiped on the next startup.

Notes:

- This is a recovery/reload flow, not a hot runtime reset — pending in-memory tab events are not preserved.
- The returned promise may never settle in the caller: the page typically unloads first.
- For `clean: true`, the worker durably records a reset request epoch (in IndexedDB) before broadcasting. Whichever worker wins the post-reload election applies the wipe exactly once; the request expires after 10 minutes if the reload never happens.
- Each persisted worker DB has a storage generation id, and a wiped DB gets a new one. A tab that sees a different id from the worker serving it reloads, because its in-memory copy came from a DB that no longer exists. This handles the case where a newly elected worker wiped the DB on startup.

### Breaking Storage Changes

To deploy a code change that old persisted local DBs cannot survive, bump `storageVersion` in `startDbWorker`:

```ts
await startDbWorker({
  syncDbSchema,
  storageVersion: "2",
  // ...
});
```

The worker durably stores the combined version (app version + internal library storage version). When the elected worker starts with a version that does not match the stored one, it wipes the local DB during initialization and records the new version after a successful init. Clients on the old version are unaffected until they load the new code. Once a worker running the new code is elected and wipes the DB, tabs still open on the previous DB reload (see [Reload and Recovery](#reload-and-recovery)).

---

## Server Setup

### Cloudflare Durable Object

The server uses a Cloudflare Durable Object with embedded SQLite storage. The `@sqlite-sync/cloudflare` package provides `durableObjectAdapter` which handles event storage, conflict resolution, and client synchronization.

```ts
// src/server.ts
import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { syncDbSchema } from "./db-schema";

export class SyncServer extends Server<Env> {
  static options = { hibernate: true };
  private remoteHandler: RemoteHandler = null!;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    durableObjectAdapter.enableHeartbeatAutoResponse(ctx);
  }

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
| `crdtEventsTable` | `string?` | Name of the SQLite table for storing CRDT events. Default: `"crdt_events"`. |
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

### Heartbeats

Clients ping connections that have received nothing for 25 seconds, to detect sockets that died without closing. `handleMessage` answers the plain-text `"ping"` with `"pong"`, but each ping would wake a hibernating Durable Object. Calling `durableObjectAdapter.enableHeartbeatAutoResponse(ctx)` from the constructor makes the Cloudflare runtime answer instead, without waking it. A Durable Object has a single auto-response pair, so the call replaces any pair set before.

Deploy servers before clients: a server that does not answer pings makes clients replace idle connections every 35 seconds or so.

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

Server-side SQL uses the **CRDT view name** (e.g., `"item"`). The Durable Object adapter creates writable views
from the schema, filters out tombstoned rows, and converts inserts, updates, and deletes into CRDT events inside the
same transaction.

```ts
syncDb.executeKysely((db) =>
  db.updateTable("item").set({ processingStatus: "complete" }).where("id", "=", itemId),
);
```

Each `execute` call accepts one SQL statement. Multiple mutations can also be submitted through the event API below.

`syncDb.unsafe` provides `execute`, `executeKysely`, and `transaction` methods that skip intent draining. The same rules as [Unsafe SQL](#unsafe-sql) apply.

### Writing Events

```ts
syncDb.applyEvent({
  type: "item-updated",
  dataset: "_item",
  item_id: itemId,
  payload: { processingStatus: "complete", tags: JSON.stringify(["action", "sci-fi"]) },
});
```

`applyEvent` and `applyEvents` validate payloads against the schema and apply them in one transaction before returning,
so the row can be read back immediately. An invalid event throws `CrdtEventValidationError` and nothing is written.
Each event in an `applyEvents` batch is typed against its own `dataset`.

To delete from the server, apply an `item-deleted` event. The payload is omitted because the tombstone is materialized when the event is applied:

```ts
syncDb.applyEvent({
  type: "item-deleted",
  dataset: "_item",
  item_id: itemId,
});
```

Applied events are broadcast to all connected clients.

### Snapshots

For server-owned rows whose intermediate states do not need to stay in change history (e.g. a streamed message), patch the row and write a full-row snapshot:

```ts
syncDb.applySnapshot({
  dataset: "_message",
  id: messageId,
  patch: { content: accumulatedText, status: "streaming" },
});
```

`applySnapshot` reads the current row if there is one, applies the patch, and writes an `item-created` event with the complete row and `tombstone: false`. Existing rows treat it as an update, and a deleted row is restored. Event listeners receive it as `item-created`.

Older events for the row stay in the log, but their payloads are replaced with a no-op marker. Sync cursors and checksums stay intact while superseded data is dropped. Fresh replicas replay the no-ops, then the snapshot.

- If an event for the row is newer than the snapshot (e.g. a pending client edit from a clock running ahead), the history is kept: that event still wins for its fields, and fresh replicas need the history to replay it. The next snapshot newer than every event for the row compacts it.
- If the row does not exist, the patch must supply every required column. This path does not run runtime schema validation, so SQLite rejects an incomplete create. TypeScript prevents patching `id` or `tombstone`.
- Use it only where discarding the row's change history is intentional.

### Server-only tables

By default any replica can author events for a table. Pass `writes: "server"` when only
the Durable Object should originate those events:

```ts
const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
    job: t.table({ status: t.text() }, { writes: "server" }),
  },
  migrations,
});
```

Clients still receive and query the table. On push, the Durable Object drops client events for
server-only tables (see [Client push validation](#client-push-validation)). Server
`applyEvent`, `applyEvents`, `applySnapshot`, and SQL writes are not filtered.

`writes` and `ai` are separate knobs. A server-side agent can still mutate a server-only table
unless you also pass `ai: "read-only"`.

Client types treat server-only CRDT views as read-only. Raw SQL still runs if types are ignored,
since write triggers are not restricted. Such a write stays local to that client, which eventually
reports a de-sync.

### Client push validation

The Durable Object checks every pushed event with
[`admitClientPush`](#admitclientpushoptions) before persisting it. Rejected events are dropped
and logged with `console.warn`, grouped by reason. The rest of the batch is persisted, and the
push still returns `ok: true`. An event is rejected when:

- its `timestamp` is not a canonical HLC string, or is more than 6 hours ahead of the server clock
- its `schema_version` is not a non-negative integer, or is newer than the server's latest version
- its payload is not a JSON object
- migrating it to the server's latest version throws
- after migration, its dataset is not the base table name of a declared table that clients can
  write. Server-only tables, CRDT view names, and other spellings such as `_TODO` or
  `main._todo` are rejected.
- after migration, its payload does not match the table schema: unknown or missing columns,
  values of the wrong type, an `id` that differs from `item_id`, an `id` in an update, or an update
  that sets `tombstone` to `true`/`1` (deletes must use `item-deleted`)

Older-version events are migrated before they are checked. Events whose table was dropped by a
migration, and events with a no-op payload, are stored as no-ops.

The client that pushed a rejected event keeps its local copy. Its checksum no longer matches the
server's, so it reports a [de-sync](#de-sync-and-schema-mismatch) once it is caught up. A device
whose clock runs more than 6 hours fast cannot sync until its clock is corrected.

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

`@sqlite-sync/ai` exposes a synced database to an AI SDK (v6) agent. Create the access object where the CRDT storage lives (for example a Durable Object's `onStart`, after migrations), then hand the agent a `ToolSet`:

```ts
import { createAiDbAccess, createDbTools } from "@sqlite-sync/ai";

// Next to the storage:
const aiDbAccess = createAiDbAccess({
  executor: syncDb.unsafe,
  syncDbSchema,
  context: {
    overview: "# My app's database\n\nDeletes are soft-deletes; the views below already hide them.",
  },
});

// In the agent:
const tools = createDbTools({ access: () => aiDbAccess });
```

The schema doc is built from the declared sync schema's table builders (including table/column `.describe()` text and enum values) plus `context.overview`. No database access. For cross-Durable-Object setups, `AiDbAccess` method names are the RPC contract: a stub that proxies `getSchemaDoc()` and `query()` satisfies `createDbTools`. The default `ToolSet` contains `getDbSchema` and `queryDb`.

To allow AI writes, pass the CRDT storage to `createAiDbAccess` and opt in when creating tools:

```ts
const aiDbAccess = createAiDbAccess({
  executor: syncDb.unsafe,
  storage: syncDb,
  syncDbSchema,
});

const tools = createDbTools({ access: () => aiDbAccess, mutations: true });
```

This adds `mutateDb`, which accepts `item-created`, `item-updated`, and `item-deleted` CRDT events. It applies them through sqlite-sync's own-event path, not arbitrary write SQL, so writes are validated, persisted to the event log, applied locally, and synced normally. For `item-created` events, omit `item_id` and `payload.id`; the tool generates ids, injects them into the CRDT events, and returns them as `createdIds`.

### Limiting what an agent may touch

By default the agent can read every table in the database file and mutate every table in the sync
schema. Narrow that with the `ai` table option:

```ts
const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
    audit: t.table({ note: t.text() }, { ai: "read-only" }), // in the doc; mutateDb rejects writes
    billing: t.table({ card_last4: t.text() }, { ai: "hidden" }), // omitted from the doc; reads rejected
  },
  migrations,
});
```

What is enforced:

| Level | Effect |
| --- | --- |
| `"read-only"` | documented and queryable; `mutateDb` rejects events for the table |
| `"hidden"` | left out of the schema doc; `queryDb` rejects any statement that reads the table |

Hiding is enforced against the root pages a compiled statement opens, so views, aliases, CTEs,
subqueries and quoting variants all resolve to the same check.

Access is table-level. There is no per-column setting. SQLite bytecode names tables, not columns,
so a column cannot be hidden from reads. Blocking writes to a required column would also stop the
agent from creating rows. Put data the agent must not touch in its own table.

Hiding a table also changes two things globally:

- Reads become an allow-list of the remaining base tables, so every other table in the same
  database file (internal sync tables, and any non-synced table of your own) becomes unreadable.
- `change_history` is dropped from the doc and denied, because it reads the raw event log where
  every dataset's payloads live and so cannot be filtered per table.

Names and columns of hidden tables can still show up through SQLite schema introspection in principle.
The guard rejects `pragma_*` table-valued functions and reads of `sqlite_schema` while restricted, but
treat hiding as row-level protection, not proof the table does not exist.

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
});
```

Key requirements:
- `@sqlite.org/sqlite-wasm` must be excluded from `optimizeDeps` — it needs to load its WASM binary at runtime.
- Workers must use `"es"` format for ES module imports.

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
| `db.execute(params)` | `(params) => ExecuteResult<T>` | Execute SQL and drain CRDT change intents |
| `db.executeKysely(factory)` | `(factory) => ExecuteResult<T>` | Execute a typed Kysely query and drain intents |
| `db.unsafe.execute(params)` | `(params) => ExecuteResult<T>` | Execute SQL without draining intents |
| `db.unsafe.executeKysely(factory)` | `(factory) => ExecuteResult<T>` | Execute Kysely without draining intents |
| `db.executeTransaction(callback)` | `(callback) => T` | Run mutations in a transaction; exposes safe execution plus `trx.unsafe` |
| `db.createLiveQuery(query)` | `(query) => LiveQuery<T>` | Create a reactive query subscription |
| `db.getSharedLiveQuery(query)` | `(query) => SharedLiveQuery<T>` | Get or create a shared reactive query |
| `state.getState()` | `() => WorkerState` | Get current sync state |
| `state.subscribe(onChange)` | `(fn) => () => void` | Subscribe to state changes |
| `state.goOnline()` | `() => Promise<void>` | Connect to the remote. Resolves once the remote answers the first request, the attempt fails, or it is cancelled |
| `state.goOffline()` | `() => Promise<void>` | Disconnect from remote server. Goes offline immediately and cancels a connection attempt in progress or a scheduled retry |
| `state.sync()` | `() => void` | Pull and push in the background without waiting. See [Controlling Sync](#controlling-sync) |
| `subscribe(type, handler)` | `(type, handler) => { unsubscribe: () => void }` | Subscribe to worker notifications such as `de-sync-detected` and `remote-schema-version-mismatch` |
| `requestReload(options)` | `(options: { clean: boolean }) => Promise<void>` | Reload all tabs for this `dbId`; `clean: true` also wipes the persisted worker DB on next startup |
| `exportData(options?)` | `(options?) => SyncedDbExport` | Export the current active rows |
| `importData(data, options?)` | `(data, options?) => Promise<ImportDataResult>` | Import rows through CRDT events |
| `dispose()` | `() => Promise<void>` | Clean up all resources |

#### `defineSyncSchema(config)`

Defines the sync database schema from `t.table()` builders plus the migration history.

```ts
function defineSyncSchema<Tables extends SyncSchemaTables>(config: {
  tables: Tables;
  migrations: Migrations;
}): DefinedSyncSchema<Tables>
```

The result carries three phantom types for type inference:

- `~clientSchema` — React hooks and client `executeKysely`. Base tables are read-only. CRDT views are writable, except `{ writes: "server" }` tables.
- `~serverSchema` — server-side `executeKysely`. Base tables are read-only. All CRDT views are writable.
- `~mutationsSchema` — typed payloads for `applyEvent` / `applyEvents`. Server-only tables stay writable.

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

#### `admitClientEvents(options)`

Splits events into those whose dataset clients may write and those to drop, using the dataset rule from
[Client push validation](#client-push-validation). [`admitClientPush`](#admitclientpushoptions) applies the same rule.

```ts
function admitClientEvents<T extends { dataset: string }>(options: {
  syncDbSchema: Pick<SyncDbSchema, "tables" | "tablesConfig">;
  events: readonly T[];
}): { admitted: T[]; skipped: T[] }
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

`storageVersion` is combined with the library's internal storage version. Bump it to wipe local DBs across an incompatible deploy; see [Breaking Storage Changes](#breaking-storage-changes).

`eventLogGc` controls startup-only worker event-log garbage collection. It is disabled by default. GC keeps at least the latest 100 applied/deduped event rows, never deletes pending rows, and never deletes local rows that have not been pushed to the remote. Set `eventLogGc: true` to enable it. Cleanup is skipped while any open tab holds an in-memory copy of the database, including during worker handoff, so in practice it runs on a fresh startup.

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

Requests wait for the socket to open before they are sent. The source implements `ping` with plain-text `"ping"` and `"pong"` frames, which the server must answer (see [Heartbeats](#heartbeats)). When the socket closes, pending requests reject, the source reports the close, and the library opens a new socket after a backoff. The library closes the socket on the first `close` event, so wrappers like PartySocket do not reconnect on their own.

#### Custom remote sources

`createRemoteSource` accepts any `CreateRemoteSourceFactory`. The library calls it once per connection attempt:

```ts
type CreateRemoteSourceFactory = (opts: {
  onEventsAvailable: (event: { newSyncId: number; remoteEventHlcSum: string | null }) => void;
  onClosed: (error?: unknown) => void;
}) => RemoteSource;

type RemoteSource = {
  pullEvents: (request: EventsPullRequest) => Promise<EventsPullResponse>;
  pushEvents: (request: EventsPushRequest) => Promise<EventsPushResponse>;
  ping?: () => Promise<void>;
  disconnect?: () => void | Promise<void>;
};
```

- One source is one connection. Each call must return a new source, synchronously. Do any async setup, like fetching a token, inside the source.
- The library calls `disconnect` on every returned source exactly once, also to cancel an attempt that is still connecting. It does not wait for `disconnect` to finish.
- Call `onClosed` when the connection ends on its own. It is safe to call at any time, including during the factory call, and is ignored after `disconnect`. The library then reports `connecting` and opens a new source after a backoff. Throwing from the factory counts as a failed attempt too.
- `pullEvents` and `pushEvents` may wait for the connection to open. Once the connection has closed, they should reject so failures surface quickly.
- `ping` is optional. When present, the library pings a connection that has received nothing (no response or broadcast) for 25 seconds, and replaces it if the ping fails or gets no answer within 10 seconds. Pings never overlap, run only on an online connection, and never start after the connection closes, so a ping does not need to settle once the source has closed. Without `ping`, a connection that dies without closing is only noticed when a request times out.
- The library times requests out after 10 seconds and does not retry on the same source: any failed request closes the connection, and the library reconnects with backoff. A push response with `ok: false` also closes the connection, but the library does not reconnect until the next `state.sync()`. The remote counts as `online` once the first request succeeds.

### `@sqlite-sync/core/server`

#### `admitClientPush(options)`

Checks a client push before a server persists it; see
[Client push validation](#client-push-validation) for the rules. The Durable Object adapter calls
this on `push-events`. Admitted events are migrated to the latest schema version and keep their
push order. Pass the server's current time as `now`.

```ts
function admitClientPush<T extends PushedCrdtEvent>(options: {
  syncDbSchema: Pick<SyncDbSchema, "tables" | "tablesConfig">;
  migrator: Pick<SyncDbMigrator, "migrateEvent" | "latestSchemaVersion">;
  events: readonly T[];
  now: number;
}): {
  admitted: T[];
  rejected: { event: T; reason: PushRejectionReason; errors?: string[] }[];
}

type PushRejectionReason =
  | "invalid-timestamp"
  | "timestamp-too-far-in-future"
  | "invalid-schema-version"
  | "schema-version-too-new"
  | "invalid-payload"
  | "migration-failed"
  | "server-only-dataset"
  | "undeclared-dataset"
  | "schema-validation-failed";
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

Floating button and dialog for databases created with `createSyncedDb()`. See [Devtools](#devtools).

```tsx
function SQLiteSyncDevtools(props?: {
  className?: string;
  hidden?: boolean;
  onHiddenChange?: (hidden: boolean) => void;
}): React.ReactElement
```

### `@sqlite-sync/cloudflare`

#### `durableObjectAdapter.createCrdtStorage(options)`

Sets up CRDT storage inside a Cloudflare Durable Object.

After running your schema migrations, the adapter recreates writable CRDT views for each configured table. Each view
uses the configured CRDT table name, selects non-tombstoned rows from the base table, and stages SQL mutations as CRDT
change intents that are drained before the statement commits.

```ts
function createCrdtStorage<Schema extends SyncDbSchema>(options: {
  storage: DurableObjectStorage;
  syncDbSchema: Schema;
  nodeId: string;
  crdtEventsTable?: string;
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
| `execute(params)` | Execute raw SQL and drain CRDT change intents |
| `executeKysely(factory)` | Execute a typed Kysely query and drain intents |
| `unsafe.execute(params)` | Execute raw SQL without draining intents |
| `unsafe.executeKysely(factory)` | Execute a typed Kysely query without draining intents |
| `unsafe.transaction(callback)` | Run a direct SQLite transaction without draining intents |
| `applyEvent(event)` | Validate and immediately apply a single typed CRDT event |
| `applyEvents(events)` | Validate and immediately apply a batch of typed CRDT events atomically |
| `applySnapshot(snapshot)` | Patch a row and write a full create snapshot; older event payloads become no-ops unless a newer event exists |
| `addEventListener("event-applied", handler)` | Listen for applied events |

**`RemoteHandler`:**

| Method | Description |
|--------|-------------|
| `handleMessage(message: string)` | Parse and handle a WebSocket message. Returns `{ success: true, payload: string }` or `{ success: false, error: unknown }`. Answers the heartbeat `"ping"` with `"pong"`. |

#### `durableObjectAdapter.enableHeartbeatAutoResponse(ctx)`

```ts
function enableHeartbeatAutoResponse(ctx: DurableObjectState): void
```

Calls `ctx.setWebSocketAutoResponse` so the runtime answers client heartbeat pings. Call it from the Durable Object constructor; see [Heartbeats](#heartbeats).

### `@sqlite-sync/ai`

#### `createAiDbAccess(options)`

Creates AI access to a synced database. Query access is read-only. Mutation access is present only when a `storage` mutator is provided. Lives where the storage lives. The schema doc is generated once from the declared schema.

```ts
function createAiDbAccess(options: {
  executor: AiDbExecutor; // satisfied by a Cloudflare ServerSyncDb's unsafe executor
  storage?: AiDbMutator; // { applyEvents(events) }, satisfied by a Cloudflare ServerSyncDb; enables mutate(input)
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext; // overview/app-level notes
  limits?: { maxRows?: number; maxCellChars?: number };
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

#### `resolveAiPolicy(options)`

Reads each table's `ai` option and returns the effective access per table name. Useful for
inspection and tests. `createAiDbAccess` calls it for you.

```ts
function resolveAiPolicy(options: { syncDbSchema: SyncDbSchema }): ResolvedAiPolicy
// { tables, hasHiddenTables, readableBaseTableNames, tableAccess(dataset) }
```

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
