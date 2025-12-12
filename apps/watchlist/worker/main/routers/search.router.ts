import type { MovieWithMediaType, TVWithMediaType } from 'tmdb-ts';
import { z } from 'zod';
import { publicProcedure, router } from '../trpc';

export const searchRouter = router({
  findMovie: publicProcedure.input(z.object({ q: z.string() })).query(async ({ input, ctx }) => {
    const results = (await ctx.tmdb.search.multi({ query: input.q, include_adult: false })).results;
    return results
      .filter((result) => result.media_type === 'movie' || result.media_type === 'tv')
      .filter((result) => result.vote_count > 5)
      .map(adaptSearchResult);
  }),
});

function adaptSearchResult(result: MovieWithMediaType | TVWithMediaType) {
  if (result.media_type === 'tv') {
    return {
      type: 'tv' as const,
      title: result.name,
      tmdbId: result.id,
      posterPath: result.poster_path,
      releaseDate: result.first_air_date,
      overview: result.overview,
      popularity: result.popularity,
      voteAverage: result.vote_average,
      voteCount: result.vote_count,
    };
  }

  return {
    type: 'movie' as const,
    title: result.title,
    tmdbId: result.id,
    posterPath: result.poster_path,
    releaseDate: result.release_date,
    overview: result.overview,
    popularity: result.popularity,
    voteAverage: result.vote_average,
    voteCount: result.vote_count,
  };
}
