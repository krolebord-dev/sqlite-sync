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

  // Get full TMDB metadata for a movie or TV show (used when adding items locally)
  getTmdbMetadata: publicProcedure
    .input(z.object({ tmdbId: z.number(), type: z.enum(['movie', 'tv']) }))
    .query(async ({ input, ctx }) => {
      const { tmdbId, type } = input;

      if (type === 'movie') {
        const movie = await ctx.tmdb.movies.details(tmdbId);
        if (!movie) return null;

        return {
          type: 'movie' as const,
          tmdbId,
          title: movie.title,
          overview: movie.overview,
          duration: movie.runtime,
          episodeCount: null,
          rating: Math.round(movie.vote_average * 10),
          releaseDate: movie.release_date ? new Date(movie.release_date).getTime() : null,
          posterUrl: movie.poster_path
            ? `https://image.tmdb.org/t/p/w300${movie.poster_path}`
            : movie.backdrop_path
              ? `https://image.tmdb.org/t/p/w300${movie.backdrop_path}`
              : null,
        };
      }

      const show = await ctx.tmdb.tvShows.details(tmdbId);
      if (!show) return null;

      return {
        type: 'tv' as const,
        tmdbId,
        title: show.name,
        overview: show.overview,
        duration: show.episode_run_time.find((x) => x > 0) ?? null,
        episodeCount: show.number_of_episodes,
        rating: Math.round(show.vote_average * 10),
        releaseDate: show.first_air_date ? new Date(show.first_air_date).getTime() : null,
        posterUrl: show.poster_path
          ? `https://image.tmdb.org/t/p/w300${show.poster_path}`
          : show.backdrop_path
            ? `https://image.tmdb.org/t/p/w300${show.backdrop_path}`
            : null,
      };
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
