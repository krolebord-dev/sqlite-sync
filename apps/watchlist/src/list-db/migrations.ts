import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";

export type ListDbProps = {
  listId: string;
};

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_item", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("type", "text", (col) => col.notNull().defaultTo("movie"))
        .addColumn("tmdbId", "integer", (col) => col.notNull())
        .addColumn("priority", "integer", (col) => col.notNull().defaultTo(0))
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("posterUrl", "text")
        .addColumn("rating", "integer")
        .addColumn("overview", "text")
        .addColumn("releaseDate", "integer")
        .addColumn("duration", "integer")
        .addColumn("episodeCount", "integer")
        .addColumn("watchedAt", "integer")
        .addColumn("processingStatus", "text", (col) => col.notNull().defaultTo("idle"))
        .addColumn("tags", "text", (col) => col.notNull().defaultTo("[]"))
        .addColumn("createdAt", "integer", (col) => col.notNull()),
    ),
  ],
  1: [
    b.addColumn({ table: "_item", column: "userRating", type: "real", defaultValue: null }),
    b.addColumn({ table: "_item", column: "tagHighlights", type: "text", defaultValue: "{}" }),
  ],
}));

export const syncDbSchema = defineSyncSchema({
  tables: {
    item: t.table({
      type: t.enum(["movie", "tv"]).default("movie"),
      tmdbId: t.integer(),
      priority: t.integer().default(0),
      title: t.text(),
      posterUrl: t.text().nullable(),
      rating: t.integer().nullable(),
      overview: t.text().nullable(),
      releaseDate: t.integer().nullable(),
      duration: t.integer().nullable(),
      episodeCount: t.integer().nullable(),
      watchedAt: t.integer().nullable(),
      processingStatus: t.text().$type<"idle" | "pending" | (string & {})>().default("idle"),
      tags: t.text().default("[]"),
      createdAt: t.integer(),
      userRating: t.real().nullable().default(null),
      tagHighlights: t.text().nullable().default("{}"),
    }),
  },
  migrations,
});

export type ListItem = typeof syncDbSchema.tables.item.$row;

export type ListDb = (typeof syncDbSchema)["~clientSchema"];

export type ListSyncDbSchema = typeof syncDbSchema;
