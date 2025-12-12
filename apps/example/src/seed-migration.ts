import type { Migration } from "kysely";

export const seedMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("_todo")
      .addColumn("id", "text", (col) => col.primaryKey().notNull())
      .addColumn("title", "text", (col) => col.notNull())
      .addColumn("completed", "boolean", (col) =>
        col.notNull().defaultTo(false)
      )
      .addColumn("tombstone", "boolean", (col) =>
        col.notNull().defaultTo(false)
      )
      .execute();
  },
};

