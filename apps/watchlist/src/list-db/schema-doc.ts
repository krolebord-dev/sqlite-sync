import type { SchemaDocContext } from "@sqlite-sync/ai";

export const listDbSchemaDocContext: SchemaDocContext = {
  overview: [
    "# Watchlist database schema",
    "",
    "This is a movie and TV watchlist for a single list. Rows in `item` are the movies and",
    "shows the user wants to watch or has watched.",
    "All `id` columns are generated ids and all timestamps (`createdAt`, `releaseDate`, `watchedAt`)",
    "are unix epoch milliseconds.",
    "`tags` and `tagHighlights` are stored as JSON strings.",
    "A row is watched when `watchedAt` is set; otherwise it is still on the to-watch list.",
    "When using mutateDb, omit ids for create events; the tool generates them and returns createdIds.",
  ].join("\n"),
};
