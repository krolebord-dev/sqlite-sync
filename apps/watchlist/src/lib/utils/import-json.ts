import { generateId } from "@sqlite-sync/core";
import { z } from "zod";
import type { ListItem } from "@/list-db/migrations";
import { parseDuration } from "./parse-duration";

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

export const importSchema = z.array(importItemSchema);

export type ImportItem = z.infer<typeof importItemSchema>;

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

export function transformImportItem(item: ImportItem): ListItem {
  return {
    id: generateId(),
    tmdbId: item.tmdbId,
    type: item.type.toLowerCase() as "movie" | "tv",
    title: item.title,
    releaseDate: item.releaseDate ? new Date(item.releaseDate).getTime() : null,
    priority: parsePriority(item.priority),
    overview: item.overview,
    rating: item.rating,
    duration: parseDuration(item.duration),
    episodeCount: item.episodes,
    watchedAt: item.watchedAt ? new Date(item.watchedAt).getTime() : null,
    createdAt: item.addedAt ? new Date(item.addedAt).getTime() : Date.now(),
    tags: JSON.stringify(item.tags),
    processingStatus: "idle" as const,
    posterUrl: item.posterUrl,
  };
}
