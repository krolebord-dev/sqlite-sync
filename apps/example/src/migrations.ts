import { createMigrations } from "@sqlite-sync/core";

export const migrations = createMigrations((b) => ({
  0: {
    steps: [
      b.createTable("_todo", (t) =>
        t
          .addColumn("id", "text", (col) => col.primaryKey().notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
          .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
      ),
    ],
  },
}));
