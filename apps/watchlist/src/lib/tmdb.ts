import { env } from "cloudflare:workers";
import { TMDB } from "tmdb-ts";

const cloudflareSafeFetch = ((input, init) => globalThis.fetch(input, init)) satisfies typeof fetch;

export function createTmdb(accessToken: string) {
  return new TMDB(accessToken, { fetch: cloudflareSafeFetch });
}

export const tmdb = createTmdb(env.TMDB_READ_ACCESS_TOKEN);
