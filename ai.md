# Plan: `@sqlite-sync/ai` — AI agent tools for synced databases

Goal: a new `packages/ai` package that lets app developers give an AI agent (AI SDK v6 `ToolSet`) safe, read-only access to a sqlite-sync database. Extracted from a working prototype in `~/Projects/productivity-app` (see "Reference prototype" below).

## Background & motivation

The prototype is a chat assistant (Cloudflare `Think` agent DO) that reads a user's synced DB living in a *different* DO (the sqlite-sync `durableObjectAdapter` server). Two tools were designed; the first is built and verified:

1. `getDbSchema` — returns a generated schema doc (introspected structure + app-provided semantics). **Built.**
2. `query` — read-only SQL against the CRDT views, with enforcement. **Designed, not built.**

Key constraint that shapes everything: on the server, a direct SQL write to base tables bypasses the CRDT event log, so materialized state diverges from event-sourced state → clients hit `de-sync-detected` and are prompted to wipe local data. Read-only enforcement is a correctness requirement, not just safety hygiene.

The DO adapter already creates read-only CRDT views (`createReadOnlyCrdtViews` in `packages/cloudflare/src/durable-object-adapter.ts`): recreated after migrations on every `createCrdtStorage`, named by `crdtTableName`, filtering `tombstone = 0`. Agents query those views — tombstone filtering is structural, and writes through a view error (no `INSTEAD OF` triggers).

## Empirically verified facts (workerd DO SQLite, via scratch worker)

- `PRAGMA table_info("x")` **works**, full fidelity (type/notnull/defaults) on base tables. On views it returns names+types but loses notnull/defaults → **introspect base tables, present under view names**.
- `EXPLAIN <sql>` **works** (full bytecode listing).
- `tables_used(...)` does **NOT** exist (no `SQLITE_ENABLE_BYTECODE_VTAB`) — so the memory-db approach in `packages/core/src/memory-db/sqlite-reactive-db.ts:313` (`getTablesUsed`) cannot be used as-is in DOs.
- A query against a view compiles to `OpenRead` on the **base table's root page** — important for the EXPLAIN-based guard below.
- `transactionSync` (used by `createKyselyExecutor(...).transaction`) rolls back when the callback throws — usable as a forced-rollback read-only guard.

## Package design

`packages/ai`, following repo conventions (tsup, `@sqlite-sync/source` + `workerd` export conditions, `tsgo --noEmit` typecheck, synced version). Dependencies:

- `@sqlite-sync/core` (workspace) — types only (`SyncDbSchema`, export `CrdtTableConfig` from core if not already public).
- Peer: `ai` ^6, used **only** in `tools.ts`. No zod peer — use `jsonSchema()` from `ai` for tool input schemas.
- **No** dependency on `@sqlite-sync/cloudflare`. The runtime-specific executor is injected (cloudflare's `createKyselyExecutor` satisfies it); this keeps the package usable for client-side (wasm memory DB) tools later.

```
packages/ai/src/
  schema-doc.ts    # createSchemaDoc + SchemaDocContext      (no deps)
  db-access.ts     # createAiDbAccess                        (core types only)
  query-guard.ts   # phase 2: table-access analysis + caps   (no deps)
  tools.ts         # createDbTools                           (peer: ai)
  index.ts
```

### API 1: `createSchemaDoc`

Port of the prototype's `buildDbSchemaDoc` (`productivity-app/src/user-db/schema-doc.ts`) — copy that implementation, it is tested against real storage:

```ts
export type SchemaDocContext = {
  overview?: string;
  tables?: Record<string, { description?: string; columns?: Record<string, string> }>;
};

export function createSchemaDoc(opts: {
  execute: (sql: string) => Record<string, unknown>[];
  syncDbSchema: SyncDbSchema;          // iterates .tablesConfig
  context?: SchemaDocContext;
}): string;
```

Behavior: for each table config, `PRAGMA table_info(<quoted baseTableName>)`, skip the `tombstone` column, render a markdown section titled with `crdtTableName`, merging the consumer's per-table/per-column description strings. Prepend `context.overview`. Context keys are **view names**.

### API 2: `createAiDbAccess` — the server-side seam

Lives where the storage lives; its method names are the RPC contract so a DO stub proxying to it satisfies the same interface as the local object:

```ts
export type AiDbAccess = {
  getSchemaDoc(): string;
  query(input: { sql: string; parameters?: unknown[] }): AiQueryResult;  // phase 2
};

export function createAiDbAccess(opts: {
  executor: AiDbExecutor;              // { execute, transaction } — KyselyExecutor shape
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext;
  limits?: { maxRows?: number; maxCellChars?: number };
}): AiDbAccess;
```

`AiDbExecutor` requires: `execute(sql, parameters) → { rows }` and `transaction(cb)` that **rolls back when `cb` throws**. Document that contract explicitly.

### API 3: `createDbTools` — thin AI SDK layer

```ts
export function createDbTools(opts: {
  access: () => MaybePromise<{
    getSchemaDoc(): MaybePromise<string>;
    query?(input: AiQueryInput): MaybePromise<AiQueryResult>;
  }>;
}): ToolSet;  // emits { getDbSchema } and, when access exposes query, { query }
```

`access` is a factory because in the cross-DO case the stub is acquired async per call. This module owns tool descriptions, LLM-facing result formatting, and error messages written so the model can self-correct (e.g. "table X is not accessible; available tables: …").

### Phase 2: `query` enforcement (query-guard.ts)

Layered, in order:

1. Normalize: strip string literals (handle `''` escapes), reject multi-statement (`;` in what remains).
2. `EXPLAIN <sql>` → reject if any write-class opcode (`OpenWrite`, `Clear`, schema-change ops); collect `OpenRead` root pages (p2), map to names via `sqlite_master.rootpage`, require every name ∈ {base tables of configured CRDT views}. This is **default-deny**: event log tables, consumer-app tables (e.g. do-jobs' `__jobs`), everything unknown is rejected with zero configuration. Do NOT use naming conventions (underscore prefixes) — table names are user-provided.
3. Execute inside `executor.transaction` and force rollback via sentinel throw — the unconditional write guarantee backing any analysis gap (precedent: `getClearedTables` exists because `tables_used` missed whole-table deletes).
4. Shape results: `{ columns, rows, rowCount, truncated }`, capped by `limits` (suggested defaults: 200 rows, 2000 chars/cell).

Follow-up (separate task): point the devtools query runner (`packages/devtools/src/devtools.tsx` ~line 100) at the same guard module to consolidate the three query-rule implementations.

## Reference prototype (productivity-app, working)

- `src/user-db/schema-doc.ts` — `buildDbSchemaDoc` + `userDbSchemaDocContext` (example of consumer context: sign conventions, enums, markdown columns).
- `src/user-db/user-db-server.ts` — `getDbSchemaDoc()` RPC on the partyserver DO. Reached via `getServerByName`, which awaits the target's `onStart()` (so migrations/views exist — this guarantee is in partyserver's docs for the function).
- `src/agent/assistant-agent.ts` — `getTools()` with the schema tool; derives the user-db DO name from its own instance name (`${userDbName}:${conversationId}`), which is the authorization (routing guard validates names at creation).

After extraction, the app should reduce to: `createAiDbAccess({ executor: createKyselyExecutor(ctx.storage), syncDbSchema, context })` in `onStart`, RPC methods delegating to it, and `getTools() { return createDbTools({ access: () => this.getUserDbStub() }) }`.

## Testing

- Node vitest against the wasm memory DB, matching `packages/core/test/` style: doc rendering (golden output), guard verdicts (allowed view query / write via base table / sneaky `WITH … INSERT` / multi-statement / unknown table / string-literal false-positive cases), rollback behavior.
- workerd-specific facts above are already verified empirically; note them in code comments. Optional later: `@cloudflare/vitest-pool-workers` for true-DO tests.

## Sequencing

1. **Phase 1 (start here):** `packages/ai` with `createSchemaDoc` + `createAiDbAccess` (schema doc only) + `createDbTools`. Migrate productivity-app onto it as validation.
2. **Phase 2:** `query-guard.ts` + `AiDbAccess.query` + query tool + tests.
3. **Later:** tool-approval metadata, devtools guard consolidation, client-side tool variant, write/mutation helpers (deliberately out of scope — writes need domain invariants, e.g. productivity-app's account-balance maintenance, that schema validation can't express).

## Open decisions (owner: krolebord)

- Should `createCrdtStorage` optionally return an `AiDbAccess` for convenience? (Couples cloudflare→ai; current lean: no, compose in userland.)
- Tool naming: `getDbSchema`/`query` vs. prefixed names for apps merging multiple DBs into one agent.
- Whether `createSchemaDoc` should support documenting extra non-CRDT tables a consumer explicitly opts in.
