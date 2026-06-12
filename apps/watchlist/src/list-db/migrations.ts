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
    item: t
      .table({
        type: t.enum(["movie", "tv"]).default("movie").describe("movie | tv."),
        tmdbId: t.integer().describe("TMDB media id."),
        priority: t.integer().default(0).describe("Manual sort position, ascending."),
        title: t.text().describe("Movie or TV show title."),
        posterUrl: t.text().nullable().describe("Poster image URL, if available."),
        rating: t.integer().nullable().describe("TMDB rating on a 0-100 scale, if available."),
        overview: t.text().nullable().describe("TMDB synopsis."),
        releaseDate: t.integer().nullable().describe("Release date as unix epoch milliseconds, if known."),
        duration: t.integer().nullable().describe("Movie runtime in minutes, if known."),
        episodeCount: t.integer().nullable().describe("TV episode count, if known."),
        watchedAt: t
          .integer()
          .nullable()
          .describe("When the user marked the item watched, as unix epoch milliseconds."),
        processingStatus: t
          .text()
          .$type<"idle" | "pending" | (string & {})>()
          .default("idle")
          .describe("AI enrichment status."),
        tags: t.text().default("[]").describe("JSON array of user-facing tags."),
        createdAt: t.integer().describe("When the item was added, as unix epoch milliseconds."),
        userRating: t.real().nullable().default(null).describe("User rating, if set."),
        tagHighlights: t.text().nullable().default("{}").describe("JSON object with AI-generated tag evidence."),
      })
      .describe("Movies and TV shows in the user's watchlist."),
  },
  migrations,
});

export type ListItem = typeof syncDbSchema.tables.item.$row;

export type ListDb = (typeof syncDbSchema)["~clientSchema"];

export type ListSyncDbSchema = typeof syncDbSchema;
