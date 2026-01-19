import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

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

export const syncDbSchema = createSyncDbSchema({
  migrations,
})
  .addTable<Todo>()
  .withConfig({ baseTableName: "_todo", crdtTableName: "todo" })
  .build();

export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  tombstone?: boolean;
};
