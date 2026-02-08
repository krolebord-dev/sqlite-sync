import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

export type UserDbProps = {
  userId: string;
};

// Placeholder table for future app-specific features (notes, todos, expenses, habits, etc.)
// Each feature will add its own tables via new migration versions.

export type PlaceholderItem = {
  id: string;
  type: string;
  title: string;
  createdAt: number;
  tombstone?: boolean;
};

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_item", (t) =>
      t
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("type", "text", (col) => col.notNull().defaultTo("note"))
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("createdAt", "integer", (col) => col.notNull()),
    ),
  ],
}));

export type UserDb = (typeof syncDbSchema)["~clientSchema"];

export type UserSyncDbSchema = typeof syncDbSchema;

export const syncDbSchema = createSyncDbSchema({
  migrations,
})
  .addTable<PlaceholderItem>()
  .withConfig({ baseTableName: "_item", crdtTableName: "item" })
  .build();
