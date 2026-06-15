import z from "zod";
import { getTmdb, getTmdbErrorMessage } from "@/lib/tmdb";
import { protectedProcedure } from "../common/procedure";

const getRegions = protectedProcedure.handler(async ({ errors }) => {
  try {
    const regions = await getTmdb().watchProviders.getRegions();
    return regions.results as { iso_3166_1: string; english_name: string; native_name: string }[];
  } catch (error) {
    throw errors.TMDB_UNAVAILABLE({
      message: getTmdbErrorMessage(error),
    });
  }
});

const getProviders = protectedProcedure
  .input(z.object({ region: z.string().optional() }))
  .handler(async ({ input, errors }) => {
    try {
      const [movieProviders, tvProviders] = await Promise.all([
        getTmdb().watchProviders.getMovieProviders(input.region ? { watch_region: input.region as never } : undefined),
        getTmdb().watchProviders.getTvProviders(input.region ? { watch_region: input.region as never } : undefined),
      ]);
      const allProviders = [...movieProviders.results, ...tvProviders.results];
      const unique = new Map<number, (typeof allProviders)[number]>();
      for (const p of allProviders) {
        if (!unique.has(p.provider_id)) unique.set(p.provider_id, p);
      }
      return [...unique.values()]
        .sort((a, b) => a.display_priority - b.display_priority)
        .map((p) => ({
          providerId: p.provider_id,
          providerName: p.provider_name,
          logoPath: p.logo_path,
        }));
    } catch (error) {
      throw errors.TMDB_UNAVAILABLE({
        message: getTmdbErrorMessage(error),
      });
    }
  });

export const watchProvidersRouter = {
  getRegions,
  getProviders,
};
