import type { Movie, TV } from "tmdb-ts";
import z from "zod";
import { adaptTrendingResult } from "@/lib/tmdb-adapters";
import { tmdb } from "@/lib/tmdb";
import { protectedProcedure } from "../common/procedure";

type MovieOrTv = Movie | TV | (Movie & { media_type: "movie" }) | (TV & { media_type: "tv" });

const getTrending = protectedProcedure
  .input(
    z.object({
      mediaType: z.enum(["movie", "tv", "all"]).default("all"),
      timeWindow: z.enum(["day", "week"]).default("day"),
      page: z.number().min(1).max(500).default(1),
    }),
  )
  .handler(async ({ input }) => {
    const results = await tmdb.trending.trending(input.mediaType, input.timeWindow, { page: input.page });
    const filtered = results.results.filter((result): result is MovieOrTv => {
      const mediaType = "media_type" in result ? result.media_type : input.mediaType;
      return mediaType === "movie" || mediaType === "tv";
    });
    return {
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: filtered.map((result) => adaptTrendingResult(result, input.mediaType)),
    };
  });

export const trendingRouter = {
  getTrending,
};
