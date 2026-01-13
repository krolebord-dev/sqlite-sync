import { env } from "cloudflare:workers";
import { TMDB } from "tmdb-ts";

export const tmdb = new TMDB(env.TMDB_READ_ACCESS_TOKEN);
