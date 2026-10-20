# @sqlite-sync/react-native

React Native adapter for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) — a local-first SQLite sync engine with reactive queries, offline persistence, and CRDT-based replication.

The browser build of `@sqlite-sync/core` keeps an in-memory SQLite copy in each tab and persists it to OPFS through a Web Worker. React Native has a single JS runtime, so this package runs the same engine on one persisted [op-sqlite](https://github.com/OP-Engineering/op-sqlite) connection instead. Schemas, migrations, the sync protocol and the [`@sqlite-sync/react`](https://www.npmjs.com/package/@sqlite-sync/react) hooks are shared with the web.

## Install

```bash
pnpm add @sqlite-sync/react-native @sqlite-sync/core @op-engineering/op-sqlite react-native-get-random-values kysely
```

`react-native-get-random-values` provides the secure random source for IDs; `@sqlite-sync/react-native` imports it for you, but it has to be a direct dependency of the app so its native module is autolinked.

sqlite-sync needs SQLite's bytecode virtual tables. Enable them in your app's `package.json`, then rebuild the native app:

```json
{
  "op-sqlite": {
    "sqliteFlags": "-DSQLITE_ENABLE_BYTECODE_VTAB=1"
  }
}
```

## Quick start

```ts
import { createSyncedDb, createWsRemoteSource } from "@sqlite-sync/react-native";
import { syncDbSchema } from "./db-schema";

const db = await createSyncedDb({
  dbId: "my-app-db",
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () => new WebSocket("wss://your-server.example.com/sync"),
  }),
  verifySchema: __DEV__,
});
```

Pass `db` to the `DbProvider` from `@sqlite-sync/react`. See the [React Native section of the docs](https://github.com/krolebord-dev/sqlite-sync/blob/main/docs.md#react-native) for all options, reload handling, and custom drivers.
