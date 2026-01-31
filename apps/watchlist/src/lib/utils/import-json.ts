import { z } from "zod";
import { parseDuration } from "./parse-duration";
import { UserError } from "./user-error";

export const importItemSchema = z.object({
  title: z.string(),
  type: z.enum(["Movie", "TV"]),
  priority: z.enum(["Normal", "High", "Low"]),
  rating: z.number().nullable(),
  duration: z.string().nullable(),
  episodes: z.number().nullable(),
  releaseDate: z.string().nullable(),
  watchedAt: z.string().nullable(),
  tags: z.array(z.string()),
  overview: z.string().nullable(),
  tmdbId: z.number(),
  addedAt: z.string(),
  posterUrl: z.string().nullable(),
});

const importSchema = z.array(importItemSchema);

function parsePriority(priority: string): number {
  switch (priority) {
    case "High":
      return 1;
    case "Low":
      return -1;
    default:
      return 0;
  }
}

function parseDate(dateString: string | null): number | null {
  if (!dateString) return null;
  const timestamp = new Date(dateString).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseDateRequired(dateString: string | null, fallback: number): number {
  const result = parseDate(dateString);
  return result ?? fallback;
}

function parseRating(rating: number | null, maxRating: number): number | null {
  if (rating === null) return null;
  if (rating > 100) return 100;
  if (rating < 0) return 0;
  if (maxRating <= 1) return rating * 100;
  if (maxRating <= 10) return rating * 10;
  return rating;
}

export function parseImportItemsFromJson(text: string) {
  const json = JSON.parse(text);

  const parseResult = importSchema.safeParse(json);
  if (!parseResult.success) {
    throw new UserError("Invalid JSON format. Please check the file structure.");
  }

  const items = parseResult.data;

  if (items.length === 0) {
    throw new UserError("No items found in the file.");
  }

  let maxRating = items[0].rating ?? 0;
  for (const item of items) {
    if (item.rating !== null) {
      maxRating = Math.max(maxRating, item.rating);
    }
  }

  return items.map((item) => ({
    tmdbId: item.tmdbId,
    type: item.type.toLowerCase() as "movie" | "tv",
    title: item.title,
    releaseDate: parseDate(item.releaseDate),
    priority: parsePriority(item.priority),
    overview: item.overview,
    rating: parseRating(item.rating, maxRating),
    duration: parseDuration(item.duration),
    episodeCount: item.episodes,
    watchedAt: parseDate(item.watchedAt),
    createdAt: parseDateRequired(item.addedAt, Date.now()),
    tags: JSON.stringify(item.tags),
    processingStatus: "idle" as const,
    posterUrl: item.posterUrl,
    userRating: null,
    tagHighlights: "{}",
  }));
}
