import { generateText } from 'ai';
import type { TMDB } from 'tmdb-ts';
import { createWorkersAI } from 'workers-ai-provider';

type GetItemMetadataOptions = {
  tmdbId: number;
  type: 'movie' | 'tv';
  tmdb: TMDB;
  ai: Ai;
  tags: { id: string; name: string }[];
};
export async function getItemMetadata(options: GetItemMetadataOptions) {
  const { tmdbId, type, tmdb, ai, tags } = options;

  const tmdbMetadata = await getTmdbMetadata(tmdb, tmdbId, type);

  if (!tmdbMetadata) {
    return null;
  }

  const aiMetadata = await getAiMetadata(ai, tags, tmdbMetadata).catch((_error) => {
    console.error('Error getting AI metadata', _error);
    return null;
  });

  return {
    tmdb: tmdbMetadata,
    ai: aiMetadata,
  };
}

async function getTmdbMetadata(tmdb: TMDB, tmdbId: number, type: 'movie' | 'tv') {
  switch (type) {
    case 'movie':
      return getMovieTMDBMetadata(tmdb, tmdbId);
    case 'tv':
      return getTVTMDBMetadata(tmdb, tmdbId);
  }
}

async function getMovieTMDBMetadata(tmdb: TMDB, tmdbId: number) {
  const movie = await tmdb.movies.details(tmdbId, ['keywords']);

  if (!movie) {
    return null;
  }

  return {
    tmdbId: tmdbId,
    title: movie.title,
    overview: movie.overview,
    genres: movie.genres.map((x) => x.name),
    duration: movie.runtime,
    episodeCount: null,
    rating: Math.round(movie.vote_average * 10),
    releaseDate: movie.release_date ? new Date(movie.release_date) : null,
    posterUrl: `https://image.tmdb.org/t/p/w300${movie.poster_path ?? movie.backdrop_path}`,
  };
}

async function getTVTMDBMetadata(tmdb: TMDB, tmdbId: number) {
  const show = await tmdb.tvShows.details(tmdbId, ['keywords']);

  if (!show) {
    return null;
  }

  return {
    tmdbId: tmdbId,
    title: show.name,
    overview: show.overview,
    genres: show.genres.map((x) => x.name),
    duration: show.episode_run_time.find((x) => x > 0) ?? null,
    episodeCount: show.number_of_episodes,
    rating: Math.round(show.vote_average * 10),
    releaseDate: show.first_air_date ? new Date(show.first_air_date) : null,
    posterUrl: `https://image.tmdb.org/t/p/w300${show.poster_path ?? show.backdrop_path}`,
  };
}

async function getAiMetadata(
  ai: Ai,
  tags: { id: string; name: string }[],
  tmdbMetadata: Exclude<Awaited<ReturnType<typeof getTmdbMetadata>>, null>,
) {
  const workersai = createWorkersAI({ binding: ai });
  // biome-ignore lint/suspicious/noExplicitAny: model types are outdated
  const model = workersai('@cf/google/gemma-3-12b-it' as any);

  const system = `
You are a tagging assistant.

Given:
- A predefined list of tags
- Metadata for a single movie or TV show

Select the tags from the predefined list that best describe the movie/TV show.

Rules:
- Only use tags from the predefined list.
- Select at most 5 tags.
- Output must be a single comma-separated list, no extra text.
`;

  let prompt = '';

  prompt += `Predefined tags:\n${tags.map((x) => x.name).join(',')}`;

  prompt += '\n\nMovie:';
  for (const [key, value] of Object.entries(tmdbMetadata)) {
    prompt += `\n${key}: ${value}`;
  }

  const selectedTags = await generateText({
    model,
    maxRetries: 2,
    system,
    prompt,
  });

  const normalizedTags = selectedTags.text.toLowerCase().replaceAll('\n', ',');
  console.log('ai-output', normalizedTags);

  return {
    tags: tags.filter((x) => normalizedTags.includes(x.name.toLowerCase())),
  };
}
