# @sqlite-sync/ai

AI agent tools for [@sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) databases. Gives an AI SDK agent safe, read-only access to a synced SQLite database.

## What's included

- `createSchemaDoc` — generates a markdown schema doc by introspecting the synced database (structure from `PRAGMA table_info`, semantics from app-provided context).
- `createAiDbAccess` — server-side access object living next to the storage; its methods double as an RPC contract for cross-Durable-Object setups.
- `createDbTools` — AI SDK v6 `ToolSet` (currently a `getDbSchema` tool) backed by an `AiDbAccess` or a stub proxying to one.

## Usage (Cloudflare Durable Object)

```ts
import { createAiDbAccess } from "@sqlite-sync/ai";
import { createKyselyExecutor, durableObjectAdapter } from "@sqlite-sync/cloudflare";

// In the DO that owns the synced database:
async onStart() {
  await durableObjectAdapter.createCrdtStorage({ syncDbSchema, storage: this.ctx.storage, /* ... */ });
  this.aiDbAccess = createAiDbAccess({
    executor: createKyselyExecutor(this.ctx.storage),
    syncDbSchema,
    context: {
      overview: "# My app's database\n\nA todo app for a single user.",
      tables: {
        todos: {
          description: "The user's todos.",
          columns: { completed: "1 when done." },
        },
      },
    },
  });
}

// RPC method for agents running elsewhere:
getDbSchemaDoc() {
  return this.aiDbAccess.getSchemaDoc();
}
```

```ts
import { createDbTools } from "@sqlite-sync/ai";

// In the agent:
getTools() {
  return createDbTools({
    access: async () => {
      const stub = await this.getUserDbStub();
      return { getSchemaDoc: () => stub.getDbSchemaDoc() };
    },
  });
}
```

`context.tables` keys are CRDT view names (`crdtTableName`). The doc skips the internal `tombstone` column and introspects base tables (views lose `NOT NULL` fidelity), presenting them under their view names.

The generated doc always includes a built-in preamble (after your `overview`) explaining sqlite-sync mechanics — that the database syncs between devices and that the listed tables are read-only views with soft-deleted rows already filtered out. Your `context` only needs to describe your domain: what the app is, what each table/column means, and any data conventions (units, enums, timestamp formats).
