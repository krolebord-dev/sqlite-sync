import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";

export type ListDbProps = {
  listId: string;
};

export type ListItem = {
  id: string;
  type: "movie" | "tv";
  tmdbId: number;
  priority: number;
  title: string;
  posterUrl: string | null;
  rating: number | null;
  overview: string | null;
  releaseDate: number | null;
  duration: number | null;
  episodeCount: number | null;
  watchedAt: number | null;
  createdAt: number;
};

const migrations = createMigrations((b) => ({
  0: {
    steps: [
      b.createTable("_item", (t) =>
        t
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
          .addColumn("createdAt", "integer", (col) => col.notNull()),
      ),
    ],
  },
}));

export type ListDb = (typeof syncDbSchema)["~schema"];

export const syncDbSchema = createSyncDbSchema({
  migrations,
})
  .addTable<ListItem>()
  .withConfig({ baseTableName: "_item", crdtTableName: "item" })
  .build();
