# @sqlite-sync/ai

AI agent tools for [@sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) databases. An AI SDK agent gets read-only access to a synced SQLite database by default, plus an opt-in CRDT mutation tool.

## What's included

- `createSchemaDoc` builds a markdown schema doc from the declared sync schema. Structure comes from the `t.table()` builders; semantics come from `.describe()` and app-provided context. No database access needed.
- `createAiDbAccess` is the server-side access object that sits next to storage. Its methods are also the RPC contract for cross-Durable-Object setups.
- `createDbTools` builds an AI SDK v6 `ToolSet` (`getDbSchema`, `queryDb`, and optional `mutateDb`) from an `AiDbAccess` or a stub that proxies to one.

`queryDb` accepts a single `SELECT`/`WITH`/`VALUES` statement. The guard checks SQLite `EXPLAIN` bytecode for write opcodes, then runs the statement in a transaction that always rolls back. By default reads are not restricted by table. The agent can query every table in the database file, including sqlite-sync's internal event log, so do not put secret data in the same file unless you hide it (see below). Results are capped (default 200 rows, 2000 chars per cell) and report `truncated` so the agent can narrow its query.

`mutateDb` is opt-in. It applies `item-created`, `item-updated`, and `item-deleted` CRDT events through sqlite-sync's own-event path, so writes are validated, persisted to the event log, applied locally, and synced normally. It does not run arbitrary write SQL. For `item-created` events, omit `item_id` and `payload.id`; the tool generates ids, injects them into the CRDT events, and returns them as `createdIds`.

## Usage (Cloudflare Durable Object)

```ts
import { createAiDbAccess } from "@sqlite-sync/ai";
import { durableObjectAdapter } from "@sqlite-sync/cloudflare";

// In the DO that owns the synced database:
async onStart() {
  const { syncDb } = await durableObjectAdapter.createCrdtStorage({ syncDbSchema, storage: this.ctx.storage, /* ... */ });
  this.aiDbAccess = createAiDbAccess({
    executor: syncDb.unsafe,
    storage: syncDb, // optional; enables mutate() on the access object
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
mutateDb(input: AiMutationInput) {
  return this.aiDbAccess.mutate?.(input) ?? { error: "Database mutations are not enabled." };
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
        mutate: (input) => stub.mutateDb(input),
      };
    },
    mutations: true,
  });
}
```

The doc skips the internal `tombstone` column and renders enum columns with their allowed values and boolean columns with a `0/1` hint. Table and column descriptions come from `.describe()` on the builders.

After your `overview`, the generated doc always adds a short preamble about sqlite-sync: the database syncs between devices, and the listed tables are read-only views with soft-deleted rows already filtered out. Put domain semantics on the schema with `.describe()`. Use `context.overview` for app-level notes.

## Limiting what the agent may touch

Set `ai` on the table options. Tables are `"read-write"` unless narrowed:

```ts
const syncDbSchema = defineSyncSchema({
  tables: {
    todos: t.table({ title: t.text() }),
    // In the doc and queryable; mutateDb rejects writes.
    audit: t.table({ note: t.text() }, { ai: "read-only" }),
    // Omitted from the doc; queries that read it are rejected.
    billing: t.table({ card_last4: t.text() }, { ai: "hidden" }),
  },
  migrations,
});
```

What each level enforces:

- `"read-only"` keeps the table in the schema doc, labelled read-only, and makes `mutateDb` reject events for it.
- `"hidden"` removes it from the doc and makes `queryDb` reject any statement that reads it. Enforcement works off the root pages a compiled statement opens, so views, aliases, CTEs, subqueries and quoting tricks all resolve to the same check.

Access is table-level. There is no per-column setting. SQLite bytecode names tables, not columns, so a column cannot be hidden from reads. Blocking writes to a required column would also stop the agent from creating rows. Put data the agent must not touch in its own table.

Hiding a table has two side effects worth knowing:

- Reads switch to an allow-list of the remaining base tables, so any other table in the same database file (including non-synced tables you created yourself) becomes unreadable too.
- `change_history` is dropped from the doc and denied. That view reads the raw event log, which holds every dataset's payloads, so it cannot be filtered per table.

Names and columns of hidden tables can still show up through SQLite schema introspection in principle. The guard rejects `pragma_*` table-valued functions and reads of `sqlite_schema` while restricted, but treat hiding as row-level protection, not proof the table does not exist.
