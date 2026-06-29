import { type ToolSet, tool } from "ai";
import { getServerByName } from "partyserver";
import { z } from "zod";
import { createTmdb } from "@/lib/tmdb";
import { getTmdbTrending, searchTmdbTitles, tmdbResultToItemPayload } from "@/lib/tmdb-adapters";

// TMDB-backed tools for the ChatAgent. Context (env + the list's sync-DO name) is captured here
// rather than threaded through an RPC/auth layer, since the agent already holds it.
export function tmdbTools(ctx: { env: Env; listDbName: string }): ToolSet {
  return {
    searchTitles: tool({
      description:
        "Search TMDB for movies and TV shows by title. Returns rows already shaped like the watchlist `item` table — pass a chosen result straight to mutateDb as an item-created payload to add it.",
      inputSchema: z.object({ query: z.string().min(1).describe("Movie or TV show title to search for.") }),
      execute: async ({ query }) => {
        const tmdb = createTmdb(ctx.env.TMDB_READ_ACCESS_TOKEN);
        const results = await searchTmdbTitles(tmdb, query, { limit: 8 });
        return results.map(tmdbResultToItemPayload);
      },
    }),
    getTrending: tool({
      description:
        "Get currently trending movies and TV shows from TMDB, shaped like the `item` table — usable directly with mutateDb to add one.",
      inputSchema: z.object({
        mediaType: z.enum(["movie", "tv", "all"]).default("all"),
        timeWindow: z.enum(["day", "week"]).default("day"),
      }),
      execute: async ({ mediaType, timeWindow }) => {
        const tmdb = createTmdb(ctx.env.TMDB_READ_ACCESS_TOKEN);
        const results = await getTmdbTrending(tmdb, mediaType, timeWindow, { limit: 12 });
        return results.map(tmdbResultToItemPayload);
      },
    }),
    getWatchProviders: tool({
      description: "Get streaming/rent/buy providers for a title (by tmdbId and type) in the user's configured region.",
      inputSchema: z.object({ tmdbId: z.number(), type: z.enum(["movie", "tv"]) }),
      execute: async ({ tmdbId, type }) => {
        const stub = await getServerByName(ctx.env.ListDbServer, ctx.listDbName, { locationHint: "weur" });
        return stub.getWatchProviders({ tmdbId, type });
      },
    }),
  };
}
