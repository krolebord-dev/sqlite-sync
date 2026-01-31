import { TMDB } from "tmdb-ts";
import { z } from "zod";
import { listProcedure } from "./orpc-base";

const WATCH_PROVIDER_REGION_KEY = "settings:watch-provider-region";
const WATCH_PROVIDER_FILTER_KEY = "settings:watch-provider-filter";

const getItemWatchProviders = listProcedure
  .input(
    z.object({
      tmdbId: z.number(),
      type: z.enum(["movie", "tv"]),
    }),
  )
  .handler(async ({ input, context }) => {
    const region = context.kv.get<string>(WATCH_PROVIDER_REGION_KEY);
    if (!region) {
      return {
        link: null as string | null,
        providers: [] as { providerId: number; providerName: string; logoUrl: string }[],
      };
    }

    const tmdb = new TMDB(context.env.TMDB_READ_ACCESS_TOKEN);
    const data =
      input.type === "movie"
        ? await tmdb.movies.watchProviders(input.tmdbId)
        : await tmdb.tvShows.watchProviders(input.tmdbId);

    const results = data.results as unknown as Record<
      string,
      {
        link: string;
        flatrate?: { provider_id: number; provider_name: string; logo_path: string }[];
        rent?: { provider_id: number; provider_name: string; logo_path: string }[];
        buy?: { provider_id: number; provider_name: string; logo_path: string }[];
      }
    >;

    const regionData = results[region];
    if (!regionData) {
      return {
        link: null as string | null,
        providers: [] as { providerId: number; providerName: string; logoUrl: string }[],
      };
    }

    const allProviders = [...(regionData.flatrate ?? []), ...(regionData.rent ?? []), ...(regionData.buy ?? [])];

    const seen = new Set<number>();
    const unique = allProviders.filter((p) => {
      if (seen.has(p.provider_id)) return false;
      seen.add(p.provider_id);
      return true;
    });

    const filterIds = context.kv.get<number[]>(WATCH_PROVIDER_FILTER_KEY);
    const filtered =
      filterIds && filterIds.length > 0 ? unique.filter((p) => filterIds.includes(p.provider_id)) : unique;

    return {
      link: regionData.link as string | null,
      providers: filtered.map((p) => ({
        providerId: p.provider_id,
        providerName: p.provider_name,
        logoUrl: `https://image.tmdb.org/t/p/original${p.logo_path}`,
      })),
    };
  });

export const listWatchProvidersRouter = {
  getItemWatchProviders,
};
