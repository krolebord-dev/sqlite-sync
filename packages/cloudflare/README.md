# @sqlite-sync/cloudflare

Cloudflare backend utilities for [sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) — a local-first SQLite sync engine for web apps, with reactive queries, offline persistence, and CRDT-based replication.

This package provides a Durable Object adapter and execution helpers for running the sync backend on Cloudflare, so clients built with [`@sqlite-sync/core`](https://www.npmjs.com/package/@sqlite-sync/core) can sync CRDT event batches with a remote server.

## Install

```bash
pnpm add @sqlite-sync/cloudflare
```

## Quick start

```ts
// event-log-server.ts
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
    routePartykitRequest(request, env).then(
      (res) => res || new Response("Not Found", { status: 404 }),
    ),
} satisfies ExportedHandler<Env>;
```

## Documentation

See the [full documentation](https://github.com/krolebord-dev/sqlite-sync/blob/main/docs.md) and the [project README](https://github.com/krolebord-dev/sqlite-sync) for how sync works and client setup.

## SQL execution

The `syncDb` returned by `createCrdtStorage` exposes two execution levels:

```ts
// Normal application path: drains CRDT change intents before commit.
syncDb.executeKysely((db) => db.updateTable("item").set({ complete: true }).where("id", "=", itemId));

// Explicit low-level bypass for maintenance and recovery tooling.
syncDb.unsafe.execute({ sql: "vacuum", parameters: [] });
```

`syncDb.unsafe` also provides raw `executeKysely` and `transaction` methods. Do not use them to mutate synced views;
unsafe execution intentionally does not drain CRDT change intents.

## License

MIT
