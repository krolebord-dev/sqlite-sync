import type { SyncDbSchema } from "@sqlite-sync/core";

/**
 * App-provided semantics merged into the generated schema doc.
 * Keys of `tables` are CRDT view names (`crdtTableName`), not base table names.
 */
export type SchemaDocContext = {
  overview?: string;
  tables?: Record<string, { description?: string; columns?: Record<string, string> }>;
};

type TableInfoRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
};

function quoteId(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Generates a markdown schema doc for an AI agent by introspecting the synced database.
 * Structure comes from `PRAGMA table_info` on the base tables (introspecting the views would
 * lose NOT NULL fidelity), presented under the view names the agent queries; semantics come
 * from the consumer-provided context. The internal `tombstone` column is omitted.
 */
export function createSchemaDoc(opts: {
  execute: (sql: string) => Record<string, unknown>[];
  syncDbSchema: SyncDbSchema;
  context?: SchemaDocContext;
}): string {
  const sections: string[] = [];

  const overview = opts.context?.overview?.trim();
  if (overview) {
    sections.push(overview);
  }

  for (const table of opts.syncDbSchema.tablesConfig) {
    const tableContext = opts.context?.tables?.[table.crdtTableName];
    const columns = opts.execute(`PRAGMA table_info(${quoteId(table.baseTableName)})`) as TableInfoRow[];

    const lines = [`## ${table.crdtTableName}`];
    if (tableContext?.description) {
      lines.push("", tableContext.description.trim());
    }
    lines.push("", "Columns:");
    for (const column of columns) {
      if (column.name === "tombstone") continue;
      const description = tableContext?.columns?.[column.name];
      lines.push(
        `- \`${column.name}\` ${column.type}${column.notnull ? " NOT NULL" : ""}${description ? ` — ${description}` : ""}`,
      );
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
