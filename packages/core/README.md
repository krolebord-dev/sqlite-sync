# @sqlite-sync/core

Core sync engine for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) — a local-first SQLite sync engine for web apps, with reactive queries, offline persistence, and CRDT-based replication.

This package provides:

- `createSyncedDb()` for client orchestration (worker attach, snapshot hydration, sync state).
- The schema builder (`createSyncDbSchema`) and migrations (`createMigrations`).
- Live query primitives (`db.createLiveQuery(...)`), typed through [Kysely](https://kysely.dev/).
- CRDT primitives with Last-Write-Wins per-field replication and HLC timestamps.
- The worker runtime (`@sqlite-sync/core/worker`) and server protocol types (`@sqlite-sync/core/server`).

## Install

```bash
pnpm add @sqlite-sync/core kysely
```

For React bindings, add [`@sqlite-sync/react`](https://www.npmjs.com/package/@sqlite-sync/react).

## Quick start

```ts
import { createMigrations, createSyncDbSchema, createSyncedDb } from "@sqlite-sync/core";

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

const worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" });

export const db = await createSyncedDb({
  dbId: "app-db",
  worker,
  workerProps: undefined,
  syncDbSchema,
});
```

Start the worker (remote sync optional):

```ts
// db-worker.ts
import { startDbWorker } from "@sqlite-sync/core/worker";
import { syncDbSchema } from "./db-schema";

await startDbWorker({ syncDbSchema });
```

## Requirements

- Browser: Web Workers + Web Locks + an OPFS-capable SQLite WASM environment.
- Peer dependency: `kysely` (`^0.28.0 || ^0.29.0`).

## Documentation

See the [full documentation](https://github.com/krolebord-dev/sqlite-sync/blob/main/docs.md) and the [project README](https://github.com/krolebord-dev/sqlite-sync) for guides, recovery/storage versioning, and the Cloudflare sync backend.

## License

MIT
