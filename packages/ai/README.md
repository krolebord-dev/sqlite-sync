# @sqlite-sync/ai

AI agent tools for [@sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) databases. Gives an AI SDK agent safe, read-only access to a synced SQLite database.

## What's included

- `createSchemaDoc` — generates a markdown schema doc from the declared sync schema (structure from the `t.table()` builders, semantics from `.describe()` and app-provided context). No database access needed.
- `createAiDbAccess` — server-side access object living next to the storage; its methods double as an RPC contract for cross-Durable-Object setups.
- `createDbTools` — AI SDK v6 `ToolSet` (`getDbSchema` and `queryDb` tools) backed by an `AiDbAccess` or a stub proxying to one.

`queryDb` is strictly read-only: a single `SELECT`/`WITH`/`VALUES` statement, verified against SQLite's `EXPLAIN` bytecode for write opcodes, and executed inside a transaction that is always rolled back. Reads are **not** restricted by table — the agent can query every table in the database file (including sqlite-sync's internal event log), so don't colocate data the agent must not see. Results are capped (default 200 rows, 2000 chars per cell) and report `truncated` so the agent can narrow its query.

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
    },
  });
}

// RPC methods for agents running elsewhere:
getDbSchemaDoc() {
  return this.aiDbAccess.getSchemaDoc();
}
queryDb(input: AiQueryInput) {
  return this.aiDbAccess.query(input);
}
```

```ts
import { createDbTools } from "@sqlite-sync/ai";

// In the agent:
getTools() {
  return createDbTools({
    access: async () => {
      const stub = await this.getUserDbStub();
      return {
        getSchemaDoc: () => stub.getDbSchemaDoc(),
        query: (input) => stub.queryDb(input),
      };
    },
  });
}
```

The doc skips the internal `tombstone` column and renders enum columns with their allowed values and boolean columns with a `0/1` hint. Table and column descriptions come from `.describe()` on the builders.

The generated doc always includes a built-in preamble (after your `overview`) explaining sqlite-sync mechanics — that the database syncs between devices and that the listed tables are read-only views with soft-deleted rows already filtered out. Prefer keeping domain semantics in the schema with `.describe()` and using `context.overview` for app-level notes.
