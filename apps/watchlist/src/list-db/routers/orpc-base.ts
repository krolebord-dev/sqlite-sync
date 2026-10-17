import { isDefinedError, os } from "@orpc/server";
import type { ServerSyncDb } from "@sqlite-sync/cloudflare";
import { getUserFromRequest } from "@/lib/auth-request";
import { isAdmin } from "@/lib/user-role";
import type { ListSyncDbSchema } from "../migrations";

export interface ORPCContext {
  env: Env;
  syncDb: ServerSyncDb<ListSyncDbSchema>;
  kv: SyncKvStorage;
  storage: DurableObjectStorage;
  request?: Request;
}

export const orpcErrors = {
  UNAUTHORIZED: {},
  FORBIDDEN: {},
  NOT_FOUND: {},
  BAD_REQUEST: {},
} as const;

const osBase = os.$context<ORPCContext>().errors(orpcErrors);

type ErrorCodes = keyof (typeof osBase)["~orpc"]["errorMap"];

const loggingMiddleware = osBase.middleware(async ({ next, path }) => {
  const time = performance.now();
  try {
    const result = await next();

    const duration = performance.now() - time;
    console.log(`--- ORPC ${path.join(".")} ${Math.round(duration)}ms`);

    return result;
  } catch (error) {
    const duration = performance.now() - time;

    if (isDefinedError(error)) {
      const errorCode = (error as { code: ErrorCodes }).code;
      console.warn(`--- ORPC ${path.join(".")} ${Math.round(duration)}ms ${errorCode}`);
    } else {
      console.error(`--- ORPC Error ${path.join(".")}`);
      console.error(error);
    }

    throw error;
  }
});

export const listProcedure = osBase.use(loggingMiddleware);

export const adminListProcedure = listProcedure.use(async ({ context, next, errors }) => {
  const user = context.request ? await getUserFromRequest(context.request) : null;
  if (!user || !isAdmin(user.userRole)) {
    throw errors.FORBIDDEN();
  }
  return next();
});
