import { env } from "cloudflare:workers";
import { TMDB } from "tmdb-ts";

let tmdbClient: TMDB | undefined;

export function getTmdb(): TMDB {
  const token = env.TMDB_READ_ACCESS_TOKEN;
  if (!token) {
    throw new Error("TMDB_READ_ACCESS_TOKEN is not configured");
  }

  tmdbClient ??= new TMDB(token);
  return tmdbClient;
}

export type TmdbApiError = {
  status_message?: string;
  status_code?: number;
  success?: boolean;
};

export function getTmdbErrorMessage(error: unknown): string {
  if (isTmdbApiError(error) && error.status_message) {
    return error.status_message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Failed to fetch from TMDB.";
}

export function isTmdbApiError(error: unknown): error is TmdbApiError {
  return typeof error === "object" && error !== null && ("status_message" in error || "status_code" in error);
}
