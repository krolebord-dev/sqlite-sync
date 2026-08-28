# @sqlite-sync/devtools

Embeddable browser devtools for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync), a local-first SQLite sync engine for web apps.

Mount `<SQLiteSyncDevtools />` and you get a floating SQLite Sync button. It opens a dialog against databases registered through [`@sqlite-sync/core`](https://www.npmjs.com/package/@sqlite-sync/core). The UI renders in a shadow root, so host-app CSS (including Tailwind preflight) does not restyle it. `className` applies to the light-DOM host, not the launcher or dialog internals.

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

Database instances register when `createSyncedDb()` completes and unregister on `dispose()`. Mount the component once near the app root.

Pass `hidden` and `onHiddenChange` if your app has its own toggle. Skip them and `Ctrl+Alt+S` (⌘⌥S on macOS) hides the button. That choice is stored in `localStorage`.

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
