import { z } from "zod";
import { listProcedure } from "./orpc-base";

const AI_SUGGESTIONS_ENABLED_KEY = "settings:ai-suggestions-enabled";

const getAiSuggestionsEnabled = listProcedure.handler(async ({ context }) => {
  const value = context.kv.get<boolean>(AI_SUGGESTIONS_ENABLED_KEY);
  return { enabled: value !== false };
});

const setAiSuggestionsEnabled = listProcedure
  .input(z.object({ enabled: z.boolean() }))
  .handler(async ({ input, context }) => {
    context.kv.put(AI_SUGGESTIONS_ENABLED_KEY, input.enabled);
    return { ok: true };
  });

export const listSettingsRouter = {
  getAiSuggestionsEnabled,
  setAiSuggestionsEnabled,
};
