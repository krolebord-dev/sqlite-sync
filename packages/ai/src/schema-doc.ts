import type { ColumnMeta, SyncDbSchema } from "@sqlite-sync/core";

export type SchemaDocContext = {
  overview?: string;
};

// Library mechanics every generated doc should explain, so consumers only have to describe
// their own domain in `context`. Kept free of tombstone-column details the agent never sees.
const SCHEMA_DOC_PREAMBLE = [
  "This is a synced SQLite database — data replicates automatically between the user's devices.",
  "All writes go through a sync event log, which is why the tables listed below are exposed as",
  "read-only SQL views; soft-deleted rows are already filtered out, so query them directly",
  "without any tombstone filtering. Every table has a unique `id` text primary key.",
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
 * Generates a markdown schema doc for an AI agent from the declared sync schema's table
 * builders — no database access needed. Tables are presented under the view names the agent
 * queries; descriptions come from `.describe()` on the table and column builders.
 * The internal `tombstone` column is omitted.
 *
 * The doc always includes a built-in preamble explaining sqlite-sync mechanics (read-only
 * views, soft-deletes already filtered) after the consumer's `overview` — consumers only
 * need to describe their own domain.
 */
export function createSchemaDoc(opts: { syncDbSchema: SyncDbSchema; context?: SchemaDocContext }): string {
  const sections: string[] = [];

  const overview = opts.context?.overview?.trim();
  if (overview) {
    sections.push(overview);
  }
  sections.push(SCHEMA_DOC_PREAMBLE);

  for (const [crdtTableName, table] of Object.entries(opts.syncDbSchema.tables)) {
    const lines = [`## ${crdtTableName}`];
    if (table.description) {
      lines.push("", table.description.trim());
    }
    lines.push("", "Columns:");
    for (const [name, meta] of Object.entries(table.columns)) {
      if (name === "tombstone") continue;
      lines.push(renderColumn(name, meta));
    }
    sections.push(lines.join("\n"));
  }

  sections.push(CHANGE_HISTORY_DOC);

  return sections.join("\n\n");
}

// Documents the curated `change_history` view created over the sync event log. Unlike the table
// views above, it is NOT tombstone-filtered — it intentionally surfaces the full change log,
// including the contents of since-deleted items.
const CHANGE_HISTORY_DOC = [
  "## change_history",
  "",
  "A read-only, append-only log of every change across all tables, one row per sync event.",
  "Query it like any other view. Unlike the tables above, soft-delete filtering does NOT apply",
  "here — it includes changes to items that were later deleted, so treat it as an audit log.",
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
