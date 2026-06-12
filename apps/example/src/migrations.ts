import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";

export const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_todo", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
}));

export const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({
      title: t.text(),
      completed: t.boolean().default(false),
    }),
  },
  migrations,
});

export type Todo = typeof syncDbSchema.tables.todo.$row;
