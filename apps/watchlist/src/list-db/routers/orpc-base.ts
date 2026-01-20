import { os } from "@orpc/server";

export interface ORPCContext {}

export const orpcErrors = {
  UNAUTHORIZED: {},
  NOT_FOUND: {},
  BAD_REQUEST: {},
} as const;

const osBase = os.$context<ORPCContext>().errors(orpcErrors);

export const listProcedure = osBase;
