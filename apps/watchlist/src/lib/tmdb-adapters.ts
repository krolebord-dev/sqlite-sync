import type { Movie, MovieWithMediaType, TV, TVWithMediaType } from "tmdb-ts";
import type { TMDB } from "tmdb-ts";

export type TmdbMediaResult = {
  type: "movie" | "tv";
  title: string;
  tmdbId: number;
  posterUrl: string | null;
  releaseDate: string;
  overview: string;
  popularity: number;
  voteAverage: number;
  voteCount: number;
};

/** Row shaped like the synced `item` table (minus id), for inserts and mutateDb item-created payloads. */
export type TmdbItemInsertPayload = {
  type: "movie" | "tv";
  tmdbId: number;
  title: string;
  posterUrl: string | null;
  overview: string | null;
  rating: number | null;
  releaseDate: number | null;
  priority: 0;
  processingStatus: "idle";
  tags: "[]";
  tagHighlights: "{}";
  userRating: null;
  createdAt: number;
};

type MovieOrTv = Movie | TV | (Movie & { media_type: "movie" }) | (TV & { media_type: "tv" });

export function posterUrl(posterPath: string | null) {
  return posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : null;
}

export function adaptSearchResult(result: MovieWithMediaType | TVWithMediaType): TmdbMediaResult {
  if (result.media_type === "tv") {
    return {
      type: "tv",
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
    type: "movie",
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

export function adaptTrendingResult(
  result: MovieOrTv,
  requestedMediaType: "movie" | "tv" | "all",
): TmdbMediaResult {
  const mediaType = "media_type" in result ? result.media_type : requestedMediaType;

  if (mediaType === "tv") {
    const tv = result as TV;
    return {
      type: "tv",
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
    type: "movie",
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

export function tmdbResultToItemPayload(result: TmdbMediaResult): TmdbItemInsertPayload {
  return {
    type: result.type,
    tmdbId: result.tmdbId,
    title: result.title,
    posterUrl: result.posterUrl,
    overview: result.overview || null,
    rating: result.voteAverage,
    releaseDate: result.releaseDate ? new Date(result.releaseDate).getTime() : null,
    priority: 0,
    processingStatus: "idle",
    tags: "[]",
    tagHighlights: "{}",
    userRating: null,
    createdAt: Date.now(),
  };
}

export async function searchTmdbTitles(tmdb: TMDB, query: string, options?: { limit?: number }) {
  const results = (await tmdb.search.multi({ query, include_adult: false })).results;
  const mapped = results
    .filter((result) => result.media_type === "movie" || result.media_type === "tv")
    .filter((result) => result.vote_count > 5)
    .map((result) => adaptSearchResult(result as MovieWithMediaType | TVWithMediaType));

  return options?.limit ? mapped.slice(0, options.limit) : mapped;
}

export async function getTmdbTrending(
  tmdb: TMDB,
  mediaType: "movie" | "tv" | "all",
  timeWindow: "day" | "week",
  options?: { limit?: number },
) {
  const results = await tmdb.trending.trending(mediaType, timeWindow);
  const mapped = results.results
    .filter((result): result is MovieOrTv => {
      const type = "media_type" in result ? result.media_type : mediaType;
      return type === "movie" || type === "tv";
    })
    .map((result) => adaptTrendingResult(result, mediaType));

  return options?.limit ? mapped.slice(0, options.limit) : mapped;
}
