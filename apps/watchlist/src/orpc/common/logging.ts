import { isDefinedError } from "@orpc/server";
import { osBase } from "./os";

type ErrorCodes = keyof (typeof osBase)["~orpc"]["errorMap"];

export const loggingMiddleware = osBase.middleware(async ({ next, path }) => {
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
