import { z } from "zod";
import { listProcedure } from "./orpc-base";

const AI_SUGGESTIONS_ENABLED_KEY = "settings:ai-suggestions-enabled";
const WATCH_PROVIDER_REGION_KEY = "settings:watch-provider-region";
const WATCH_PROVIDER_FILTER_KEY = "settings:watch-provider-filter";

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

const getWatchProviderRegion = listProcedure.handler(async ({ context }) => {
  const region = context.kv.get<string>(WATCH_PROVIDER_REGION_KEY);
  return { region: region ?? null };
});

const setWatchProviderRegion = listProcedure
  .input(z.object({ region: z.string() }))
  .handler(async ({ input, context }) => {
    context.kv.put(WATCH_PROVIDER_REGION_KEY, input.region);
    return { ok: true };
  });

const getWatchProviderFilter = listProcedure.handler(async ({ context }) => {
  const providerIds = context.kv.get<number[]>(WATCH_PROVIDER_FILTER_KEY);
  return { providerIds: providerIds ?? [] };
});

const setWatchProviderFilter = listProcedure
  .input(z.object({ providerIds: z.array(z.number()) }))
  .handler(async ({ input, context }) => {
    context.kv.put(WATCH_PROVIDER_FILTER_KEY, input.providerIds);
    return { ok: true };
  });

export const listSettingsRouter = {
  getAiSuggestionsEnabled,
  setAiSuggestionsEnabled,
  getWatchProviderRegion,
  setWatchProviderRegion,
  getWatchProviderFilter,
  setWatchProviderFilter,
};
