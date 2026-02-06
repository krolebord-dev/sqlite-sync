import type { Movie, TV } from "tmdb-ts";
import z from "zod";
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
      const mediaType = "media_type" in result ? (result as any).media_type : input.mediaType;
      return mediaType === "movie" || mediaType === "tv";
    });
    return {
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: filtered.map((result) => adaptTrendingResult(result, input.mediaType)),
    };
  });

function adaptTrendingResult(result: MovieOrTv, requestedMediaType: string) {
  const mediaType = "media_type" in result ? (result as any).media_type : requestedMediaType;

  if (mediaType === "tv") {
    const tv = result as TV;
    return {
      type: "tv" as const,
      title: tv.name,
      tmdbId: tv.id,
      posterUrl: posterUrl(tv.poster_path),
      releaseDate: tv.first_air_date,
      overview: tv.overview,
      popularity: tv.popularity,
      voteAverage: Math.round(tv.vote_average * 10),
      voteCount: tv.vote_count,
    };
  }

  const movie = result as Movie;
  return {
    type: "movie" as const,
    title: movie.title,
    tmdbId: movie.id,
    posterUrl: posterUrl(movie.poster_path),
    releaseDate: movie.release_date,
    overview: movie.overview,
    popularity: movie.popularity,
    voteAverage: Math.round(movie.vote_average * 10),
    voteCount: movie.vote_count,
  };
}

function posterUrl(posterPath: string | null) {
  return posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : null;
}

export const trendingRouter = {
  getTrending,
};
