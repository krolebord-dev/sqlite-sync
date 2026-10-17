import z from "zod";
import { suggestTags as suggestTagsFn } from "../../ai/suggest-tags";
import { listProcedure } from "./orpc-base";

const suggestTags = listProcedure
  .input(z.object({ itemId: z.string() }))
  .handler(async ({ input, errors, context }) => {
    const [item] = context.syncDb.executeKysely((db) =>
      db.selectFrom("item").where("id", "=", input.itemId).select(["id", "title", "overview", "releaseDate"]),
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

    try {
      const result = await suggestTagsFn({
        item: {
          title: item.title,
          overview: item.overview ?? "No overview available",
          releaseYear: item.releaseDate === null ? null : new Date(item.releaseDate).getUTCFullYear(),
        },
        apiKey: context.env.OPENROUTER_API_KEY,
      });
      context.syncDb.applyEvent({
        type: "item-updated",
        dataset: "_item",
        item_id: input.itemId,
        payload: {
          tags: JSON.stringify([result.genre, ...result.tags]),
          processingStatus: "idle",
        },
      });
    } catch {
      context.syncDb.applyEvent({
        type: "item-updated",
        dataset: "_item",
        item_id: input.itemId,
        payload: {
          processingStatus: "Error generating tags",
        },
      });
    }

    return { ok: true };
  });

export const aiSuggestionsRouter = {
  suggestTags,
};
