import type { ColumnMeta, SyncDbSchema } from "@sqlite-sync/core";
import { resolveAiPolicy } from "./policy";

export type SchemaDocContext = {
  overview?: string;
};

// Mechanics every generated doc should explain, so `context` only needs domain notes.
// Skips tombstone-column details the agent never sees.
const SCHEMA_DOC_PREAMBLE = [
  "This is a synced SQLite database. Data replicates automatically between the user's devices.",
  "All writes go through a sync event log, which is why the tables listed below are exposed as",
  "read-only SQL views; soft-deleted rows are already filtered out, so query them directly",
  "without any tombstone filtering. Every table has a unique `id` text primary key.",
].join("\n");

// Added when any table is hidden: reads become an allow-list, and anything else fails.
const RESTRICTED_READS_NOTE = [
  "Only the tables documented below are readable. Queries that touch any other table are",
  "rejected, including the internal sync event log, so there is no change history available.",
].join("\n");

function renderColumn(name: string, meta: ColumnMeta): string {
  let line = `- \`${name}\` ${meta.sqlType.toUpperCase()}`;
  if (!meta.nullable) {
    line += " NOT NULL";
  }
  if (meta.kind === "boolean") {
    line += " (boolean 0/1)";
  } else if (meta.kind === "enum") {
    line += ` (one of ${(meta.enumValues ?? []).map((value) => `"${value}"`).join(" | ")})`;
  }
  return meta.description ? `${line} — ${meta.description}` : line;
}

/**
 * Builds a markdown schema doc for an AI agent from the declared sync schema.
 * No database access. Tables use the view names the agent queries. Descriptions come from
 * `.describe()` on the table and column builders. The internal `tombstone` column is omitted.
 *
 * Tables with `{ ai: "hidden" }` are left out. Read-only tables are labelled so the agent
 * does not try a mutation that would be rejected.
 *
 * After the consumer's `overview`, the doc always adds a short preamble about sqlite-sync
 * (read-only views, soft-deletes already filtered). Put domain notes in `overview` or
 * `.describe()`.
 */
export function createSchemaDoc(opts: { syncDbSchema: SyncDbSchema; context?: SchemaDocContext }): string {
  const policy = resolveAiPolicy({ syncDbSchema: opts.syncDbSchema });
  const sections: string[] = [];

  const overview = opts.context?.overview?.trim();
  if (overview) {
    sections.push(overview);
  }
  sections.push(SCHEMA_DOC_PREAMBLE);
  if (policy.hasHiddenTables) {
    sections.push(RESTRICTED_READS_NOTE);
  }

  for (const [crdtTableName, table] of Object.entries(opts.syncDbSchema.tables)) {
    const access = policy.tableAccess(crdtTableName);
    if (access === "hidden") continue;

    const lines = [`## ${crdtTableName}`];
    if (table.description) {
      lines.push("", table.description.trim());
    }
    if (access === "read-only") {
      lines.push("", "Read-only: you can query this table but cannot create, update, or delete its rows.");
    }
    lines.push("", "Columns:");
    for (const [name, meta] of Object.entries(table.columns)) {
      if (name === "tombstone") continue;
      lines.push(renderColumn(name, meta));
    }
    sections.push(lines.join("\n"));
  }

  if (!policy.hasHiddenTables) {
    sections.push(CHANGE_HISTORY_DOC);
  }

  return sections.join("\n\n");
}

// Documents the curated `change_history` view over the sync event log. Unlike the table
// views above, it is NOT tombstone-filtered: it shows the full change log, including
// since-deleted items. Omitted when any table is hidden, because the view reads the raw
// event log (every dataset's payloads) and cannot be filtered per table.
const CHANGE_HISTORY_DOC = [
  "## change_history",
  "",
  "A read-only, append-only log of every change across all tables, one row per sync event.",
  "Query it like any other view. Unlike the tables above, soft-delete filtering does NOT apply",
  "here. It includes changes to items that were later deleted, so treat it as an audit log.",
  "",
  "Columns:",
  "- `seq` INTEGER NOT NULL — monotonic sequence number; **order history by this** (ascending = oldest first)",
  "- `dataset` TEXT NOT NULL — which table the change applies to (matches a table name above)",
  "- `item_id` TEXT NOT NULL — the `id` of the affected row",
  '- `change_type` TEXT NOT NULL (one of "item-created" | "item-updated" | "item-deleted")',
  '- `status` TEXT NOT NULL (one of "applied" | "pending" | "failed" | "deduped") — "applied" took effect; "failed" did not; filter to `status = \'applied\'` for the effective history',
  '- `origin` TEXT NOT NULL — where the change came from (e.g. "own", "remote", "local")',
  "- `timestamp` TEXT NOT NULL — opaque hybrid-logical-clock string; do NOT parse it as a date, order by `seq` instead",
  "- `changes` TEXT NOT NULL — JSON of what the change set: the changed columns only for item-updated, the full initial row for item-created, `{}` for item-deleted. Use `json_extract(changes, '$.column')` to read a field.",
].join("\n");
