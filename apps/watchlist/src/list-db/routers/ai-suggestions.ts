import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import z from "zod";
import { suggestTags as suggestTagsFn } from "../../ai/suggest-tags";
import { listProcedure } from "./orpc-base";

const suggestTags = listProcedure
  .input(z.object({ itemId: z.string() }))
  .handler(async ({ input, errors, context }) => {
    const model = createOpenRouter({
      apiKey: context.env.OPENROUTER_API_KEY,
    })("@preset/fast-and-efficient");

    const [item] = context.syncDb.executeKysely((db) =>
      db
        .selectFrom("_item")
        .where("tombstone", "=", false)
        .where("id", "=", input.itemId)
        .select(["id", "title", "overview"]),
    ).rows;

    if (!item) {
      throw errors.NOT_FOUND();
    }

    context.syncDb.enqueueEvent({
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
        },
        model,
      });
      context.syncDb.enqueueEvent({
        type: "item-updated",
        dataset: "_item",
        item_id: input.itemId,
        payload: {
          tags: JSON.stringify([result.genre.toLowerCase(), ...result.tags]),
          processingStatus: "idle",
        },
      });
    } catch {
      context.syncDb.enqueueEvent({
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
