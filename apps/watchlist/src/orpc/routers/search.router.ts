import type { MovieWithMediaType, TVWithMediaType } from "tmdb-ts";
import z from "zod";
import { tmdb } from "@/lib/tmdb";
import { protectedProcedure } from "../common/procedure";

const search = protectedProcedure.input(z.object({ q: z.string() })).handler(async ({ input }) => {
  const results = (await tmdb.search.multi({ query: input.q, include_adult: false })).results;
  return results
    .filter((result) => result.media_type === "movie" || result.media_type === "tv")
    .filter((result) => result.vote_count > 5)
    .map(adaptSearchResult);
});

function adaptSearchResult(result: MovieWithMediaType | TVWithMediaType) {
  if (result.media_type === "tv") {
    return {
      type: "tv" as const,
      title: result.name,
      tmdbId: result.id,
      posterUrl: posterUrl(result.poster_path),
      releaseDate: result.first_air_date,
      overview: result.overview,
      popularity: result.popularity,
      voteAverage: Math.round(result.vote_average * 10),
      voteCount: result.vote_count,
    };
  }

  return {
    type: "movie" as const,
    title: result.title,
    tmdbId: result.id,
    posterUrl: posterUrl(result.poster_path),
    releaseDate: result.release_date,
    overview: result.overview,
    popularity: result.popularity,
    voteAverage: Math.round(result.vote_average * 10),
    voteCount: result.vote_count,
  };
}

function posterUrl(posterPath: string | null) {
  return posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : null;
}

export const searchRouter = {
  search,
};
