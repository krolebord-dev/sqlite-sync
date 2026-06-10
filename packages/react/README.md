# @sqlite-sync/react

React bindings for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) — a local-first SQLite sync engine for web apps, with reactive queries, offline persistence, and CRDT-based replication.

This package provides idiomatic React bindings over [`@sqlite-sync/core`](https://www.npmjs.com/package/@sqlite-sync/core): a `DbProvider` context plus the `useDb`, `useDbQuery`, `useDbState`, and `useDbEvent` hooks. Identical `useDbQuery` calls within the same provider share a single live query when SQL and parameter values match.

## Install

```bash
pnpm add @sqlite-sync/react @sqlite-sync/core kysely
```

## Quick start

```ts
// db.ts
import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { syncDbSchema } from "./db-schema";

export const { useDb, DbProvider, useDbQuery, useDbState, useDbEvent } = createDbContext(syncDbSchema);
```

```tsx
import { generateId } from "@sqlite-sync/core";
import { useDb, useDbQuery } from "./db";

export function TodoList() {
  const { db } = useDb();

  // Reactive query: re-renders when writes change the "todo" table.
  const { data: todos } = useDbQuery((kdb) =>
    kdb.selectFrom("todo").selectAll().orderBy("id", "asc"),
  );

  return (
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
      Add ({todos?.length ?? 0})
    </button>
  );
}
```

## Requirements

- Peer dependencies: `react` (`^18 || ^19`) and `kysely` (`^0.28.0 || ^0.29.0`).

## Documentation

See the [full documentation](https://github.com/krolebord-dev/sqlite-sync/blob/main/docs.md) and the [project README](https://github.com/krolebord-dev/sqlite-sync) for setup, the worker runtime, and recovery tools.

## License

MIT
