import { os } from "@orpc/server";
import type { RequestHeadersPluginContext, ResponseHeadersPluginContext } from "@orpc/server/plugins";

export interface ORPCContext extends RequestHeadersPluginContext, ResponseHeadersPluginContext {}

export const orpcErrors = {
  UNAUTHORIZED: {},
  NOT_FOUND: {},
  BAD_REQUEST: {},
} as const;

export const osBase = os.$context<ORPCContext>().errors(orpcErrors);
