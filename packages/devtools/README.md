# @sqlite-sync/devtools

Embeddable browser devtools for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) — a local-first SQLite sync engine for web apps, with reactive queries, offline persistence, and CRDT-based replication.

This package renders a floating **SQLite Sync** button that opens a dialog with a sidebar, database selector, and query tooling for inspecting databases registered through [`@sqlite-sync/core`](https://www.npmjs.com/package/@sqlite-sync/core).

## Install

```bash
pnpm add @sqlite-sync/devtools
```

## Quick start

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

Query runner rules:

- Worker DB queries are read-only.
- Memory DB queries may write only to CRDT tables.
- The UI executes a single SQL statement at a time and shows raw JSON results.

## Requirements

- Peer dependency: `react` (`^18 || ^19`).

## Documentation

See the [full documentation](https://github.com/krolebord-dev/sqlite-sync/blob/main/docs.md) and the [project README](https://github.com/krolebord-dev/sqlite-sync).

## License

MIT
