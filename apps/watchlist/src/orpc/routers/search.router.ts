import z from "zod";
import { searchTmdbTitles } from "@/lib/tmdb-adapters";
import { tmdb } from "@/lib/tmdb";
import { protectedProcedure } from "../common/procedure";

const search = protectedProcedure.input(z.object({ q: z.string() })).handler(async ({ input }) => {
  return searchTmdbTitles(tmdb, input.q);
});

export const searchRouter = {
  search,
};
