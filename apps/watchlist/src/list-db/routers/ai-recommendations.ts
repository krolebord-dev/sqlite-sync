import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { MovieWithMediaType, TVWithMediaType } from "tmdb-ts";
import { TMDB } from "tmdb-ts";
import z from "zod";
import { recommendItems } from "../../ai/recommend-items";
import { listProcedure } from "./orpc-base";

type ListItemRow = {
  id: string;
  title: string;
  type: string;
  tmdbId: number;
  tags: string;
  tagHighlights: string;
  userRating: number | null;
  watchedAt: number | null;
  priority: number;
};

function buildTasteProfile(items: ListItemRow[]) {
  const tagCounts: Record<string, number> = {};
  const likedItems: Array<{ title: string; type: string; tags: string[]; userRating: number | null }> = [];
  const dislikedPatterns: Array<{ title: string; negativeTags: string[] }> = [];

  let movieCount = 0;
  let tvCount = 0;

  for (const item of items) {
    const tags: string[] = JSON.parse(item.tags);
    const highlights: Record<string, string> = JSON.parse(item.tagHighlights);

    if (item.type === "movie") movieCount++;
    else tvCount++;

    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }

    const positiveTags = Object.entries(highlights)
      .filter(([, v]) => v === "positive")
      .map(([k]) => k);
    const negativeTags = Object.entries(highlights)
      .filter(([, v]) => v === "negative")
      .map(([k]) => k);

    if ((item.userRating != null && item.userRating >= 7) || positiveTags.length > 0 || item.priority > 0) {
      likedItems.push({
        title: item.title,
        type: item.type,
        tags,
        userRating: item.userRating,
      });
    }

    if ((item.userRating != null && item.userRating < 5) || negativeTags.length > 0) {
      dislikedPatterns.push({
        title: item.title,
        negativeTags,
      });
    }
  }

  const sortedTags = Object.fromEntries(
    Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15),
  );

  const total = movieCount + tvCount;
  const mediaTypePreference: "movie" | "tv" | "both" =
    movieCount > total * 0.7 ? "movie" : tvCount > total * 0.7 ? "tv" : "both";

  return {
    likedItems: likedItems.slice(0, 20),
    dislikedPatterns: dislikedPatterns.slice(0, 10),
    tagPreferences: sortedTags,
    existingTitles: items.map((i) => i.title),
    mediaTypePreference,
  };
}

type EnrichedRecommendation = {
  type: "movie" | "tv";
  title: string;
  tmdbId: number;
  posterUrl: string | null;
  releaseDate: string;
  overview: string;
  voteAverage: number;
  reason: string;
};

function posterUrl(posterPath: string | null) {
  return posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : null;
}

function adaptSearchResult(result: MovieWithMediaType | TVWithMediaType): Omit<EnrichedRecommendation, "reason"> {
  if (result.media_type === "tv") {
    return {
      type: "tv",
      title: result.name,
      tmdbId: result.id,
      posterUrl: posterUrl(result.poster_path),
      releaseDate: result.first_air_date,
      overview: result.overview,
      voteAverage: Math.round(result.vote_average * 10),
    };
  }

  return {
    type: "movie",
    title: result.title,
    tmdbId: result.id,
    posterUrl: posterUrl(result.poster_path),
    releaseDate: result.release_date,
    overview: result.overview,
    voteAverage: Math.round(result.vote_average * 10),
  };
}

const getRecommendations = listProcedure
  .input(z.object({ customPrompt: z.string().optional() }))
  .handler(async ({ input, context }) => {
    const model = createOpenRouter({
      apiKey: context.env.OPENROUTER_API_KEY,
    })("@preset/fast-and-efficient");

    const items = context.syncDb.executeKysely((db) =>
      db
        .selectFrom("_item")
        .where("tombstone", "=", false)
        .select(["id", "title", "type", "tmdbId", "tags", "tagHighlights", "userRating", "watchedAt", "priority"]),
    ).rows as ListItemRow[];

    if (items.length === 0) {
      return { recommendations: [] as EnrichedRecommendation[] };
    }

    const tasteProfile = buildTasteProfile(items);

    const aiResult = await recommendItems({ tasteProfile, model, customPrompt: input.customPrompt });

    const tmdb = new TMDB(context.env.TMDB_READ_ACCESS_TOKEN);
    const existingTmdbIds = new Set(items.map((i) => i.tmdbId));

    const enriched = await Promise.allSettled(
      aiResult.recommendations.map(async (rec) => {
        const searchResults = await tmdb.search.multi({
          query: rec.title,
          include_adult: false,
        });

        const match = searchResults.results.find((r) => {
          if (r.media_type !== "movie" && r.media_type !== "tv") return false;
          if (existingTmdbIds.has(r.id)) return false;
          return true;
        });

        if (!match || (match.media_type !== "movie" && match.media_type !== "tv")) {
          return null;
        }

        const adapted = adaptSearchResult(match);
        return {
          ...adapted,
          reason: rec.reason,
        } satisfies EnrichedRecommendation;
      }),
    );

    const recommendations = enriched
      .filter((r): r is PromiseFulfilledResult<EnrichedRecommendation> => r.status === "fulfilled" && r.value != null)
      .map((r) => r.value);

    return { recommendations };
  });

export const aiRecommendationsRouter = {
  getRecommendations,
};
