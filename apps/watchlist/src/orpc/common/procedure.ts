import { authMiddleware } from "./auth";
import { loggingMiddleware } from "./logging";
import { osBase } from "./os";

export const procedure = osBase.use(loggingMiddleware);

export const protectedProcedure = procedure.use(authMiddleware);
