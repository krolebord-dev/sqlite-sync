# @sqlite-sync/ai

AI agent tools for [@sqlite-sync](https://github.com/krolebord-dev/sqlite-sync) databases. Gives an AI SDK agent safe, read-only access to a synced SQLite database by default, with an explicit opt-in CRDT mutation tool.

## What's included

- `createSchemaDoc` — generates a markdown schema doc from the declared sync schema (structure from the `t.table()` builders, semantics from `.describe()` and app-provided context). No database access needed.
- `createAiDbAccess` — server-side access object living next to the storage; its methods double as an RPC contract for cross-Durable-Object setups.
- `createDbTools` — AI SDK v6 `ToolSet` (`getDbSchema` and `queryDb` tools, plus optional `mutateDb`) backed by an `AiDbAccess` or a stub proxying to one.

`queryDb` is strictly read-only: a single `SELECT`/`WITH`/`VALUES` statement, verified against SQLite's `EXPLAIN` bytecode for write opcodes, and executed inside a transaction that is always rolled back. By default reads are **not** restricted by table — the agent can query every table in the database file (including sqlite-sync's internal event log), so don't colocate data the agent must not see unless you hide it (see below). Results are capped (default 200 rows, 2000 chars per cell) and report `truncated` so the agent can narrow its query.

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

The generated doc always includes a built-in preamble (after your `overview`) explaining sqlite-sync mechanics — that the database syncs between devices and that the listed tables are read-only views with soft-deleted rows already filtered out. Prefer keeping domain semantics in the schema with `.describe()` and using `context.overview` for app-level notes.

## Limiting what the agent may touch

Declare AI access next to the schema. Tables are `"read-write"` unless narrowed:

```ts
const syncDbSchema = defineSyncSchema({
  tables: {
    todos: t.table({ title: t.text() }),
    // Queryable and documented, never mutated by the agent.
    audit: t.table({ note: t.text() }).ai("read-only"),
    // Not in the doc, and queries that read it are rejected.
    billing: t.table({ card_last4: t.text() }).ai("hidden"),
  },
  migrations,
});
```

What each level enforces:

- `"read-only"` keeps the table in the schema doc, labelled read-only, and makes `mutateDb` reject events for it.
- `"hidden"` removes it from the doc and makes `queryDb` reject any statement that reads it. Enforcement works off the root pages a compiled statement opens, so views, aliases, CTEs, subqueries and quoting tricks all resolve to the same check.

Access is table-level. There is no per-column setting: SQLite bytecode identifies tables rather than columns, so a column could not be hidden from reads, and blocking writes to a required column would make rows impossible to create. Put data the agent must not touch in its own table.

Hiding a table has two side effects worth knowing:

- Reads switch to an allow-list of the remaining base tables, so any other table in the same database file (including non-synced tables you created yourself) becomes unreadable too.
- `change_history` is dropped from the doc and denied. That view reads the raw event log, which holds every dataset's payloads, so it cannot be filtered per table.

Names and columns of hidden tables can still be discovered through SQLite's schema introspection in principle; the guard rejects `pragma_*` table-valued functions and reads of `sqlite_schema` while restricted, but treat hiding as row-level protection rather than proof the table does not exist.
