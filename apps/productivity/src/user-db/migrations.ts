import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

export type UserDbProps = {
  userId: string;
};

export type NoteItem = {
  id: string;
  type: string;
  title: string;
  content: string;
  order: number;
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
  1: [
    b.addColumn({ table: "_item", column: "content", type: "text", defaultValue: "" }),
    b.addColumn({ table: "_item", column: "order", type: "real", defaultValue: 0 }),
  ],
}));

export type UserDb = (typeof syncDbSchema)["~clientSchema"];

export type UserSyncDbSchema = typeof syncDbSchema;

export const syncDbSchema = createSyncDbSchema({
  migrations,
})
  .addTable<NoteItem>()
  .withConfig({ baseTableName: "_item", crdtTableName: "item" })
  .build();
