import z from "zod";
import { suggestTags } from "../../ai/suggest-tags";
import { createTmdb } from "../../lib/tmdb";
import { getTmdbItemDetails } from "../../lib/tmdb-adapters";
import { listProcedure } from "./orpc-base";

const indexItem = listProcedure
  .input(z.object({ itemId: z.string(), includeTags: z.boolean().default(true) }))
  .handler(async ({ input, errors, context }) => {
    const [item] = context.syncDb.executeKysely((db) =>
      db
        .selectFrom("item")
        .where("id", "=", input.itemId)
        .select(["id", "type", "tmdbId", "title", "overview", "posterUrl", "releaseDate"]),
    ).rows;

    if (!item) {
      throw errors.NOT_FOUND();
    }

    context.syncDb.applyEvent({
      type: "item-updated",
      dataset: "_item",
      item_id: input.itemId,
      payload: {
        processingStatus: "pending",
      },
    });

    const errorMessages: string[] = [];

    const details = await getTmdbItemDetails(
      createTmdb(context.env.TMDB_READ_ACCESS_TOKEN),
      item.tmdbId,
      item.type,
    ).catch((error) => {
      console.error(`Failed to load TMDB details for item ${item.id}`, error);
      errorMessages.push("Failed to load TMDB details");
      return null;
    });

    const overview = details?.overview ?? item.overview;
    const releaseDate = details?.releaseDate ?? item.releaseDate;

    const tagsResult = input.includeTags
      ? await suggestTags({
          item: {
            title: item.title,
            overview: overview ?? "No overview available",
            releaseYear: releaseDate === null ? null : new Date(releaseDate).getUTCFullYear(),
          },
          apiKey: context.env.OPENROUTER_API_KEY,
        }).catch((error) => {
          console.error(`Failed to generate tags for item ${item.id}`, error);
          errorMessages.push("Error generating tags");
          return null;
        })
      : null;

    context.syncDb.applyEvent({
      type: "item-updated",
      dataset: "_item",
      item_id: input.itemId,
      payload: {
        ...(details && {
          overview,
          releaseDate,
          posterUrl: details.posterUrl ?? item.posterUrl,
          rating: details.rating,
          duration: details.duration,
          episodeCount: details.episodeCount,
        }),
        ...(tagsResult && { tags: JSON.stringify([tagsResult.genre, ...tagsResult.tags]) }),
        processingStatus: errorMessages.length > 0 ? errorMessages.join(", ") : "idle",
      },
    });

    return { ok: true };
  });

export const itemIndexingRouter = {
  indexItem,
};
