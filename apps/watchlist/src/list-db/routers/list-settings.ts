import { z } from "zod";
import { listProcedure } from "./orpc-base";

const AI_SUGGESTIONS_ENABLED_KEY = "settings:ai-suggestions-enabled";
const WATCH_PROVIDER_REGION_KEY = "settings:watch-provider-region";
const WATCH_PROVIDER_FILTER_KEY = "settings:watch-provider-filter";

const getSettings = listProcedure.handler(async ({ context }) => {
  const aiSuggestionsEnabled = context.kv.get<boolean>(AI_SUGGESTIONS_ENABLED_KEY);
  const watchProviderRegion = context.kv.get<string>(WATCH_PROVIDER_REGION_KEY);
  const watchProviderFilter = context.kv.get<number[]>(WATCH_PROVIDER_FILTER_KEY);

  return {
    aiSuggestionsEnabled: aiSuggestionsEnabled !== false,
    watchProviderRegion: watchProviderRegion ?? null,
    watchProviderFilter: watchProviderFilter ?? [],
  };
});

const setAiSuggestionsEnabled = listProcedure
  .input(z.object({ enabled: z.boolean() }))
  .handler(async ({ input, context }) => {
    context.kv.put(AI_SUGGESTIONS_ENABLED_KEY, input.enabled);
    return { ok: true };
  });

const setWatchProviderRegion = listProcedure
  .input(z.object({ region: z.string() }))
  .handler(async ({ input, context }) => {
    context.kv.put(WATCH_PROVIDER_REGION_KEY, input.region);
    context.kv.put(WATCH_PROVIDER_FILTER_KEY, []);
    return { ok: true };
  });

const setWatchProviderFilter = listProcedure
  .input(z.object({ providerIds: z.array(z.number()) }))
  .handler(async ({ input, context }) => {
    context.kv.put(WATCH_PROVIDER_FILTER_KEY, input.providerIds);
    return { ok: true };
  });

export const listSettingsRouter = {
  getSettings,
  setAiSuggestionsEnabled,
  setWatchProviderRegion,
  setWatchProviderFilter,
};
