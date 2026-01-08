import type { ORPCContext } from "../orpc/common/os";
import { googleCallbackHandler } from "./handlers/callback.google";

export const apiHandler = createApiHandler({
  handlers: {
    "/auth/callback/google": googleCallbackHandler,
  },
  prefix: "/api",
});

export type ApiHandler = (ctx: {
  context: ORPCContext & { url: URL };
  request: Request;
}) => Promise<Response> | Response;

function createApiHandler({ handlers, prefix }: { handlers: Record<string, ApiHandler>; prefix: string }) {
  const handlersMap = new Map<string, ApiHandler>(
    Object.entries(handlers).map(([path, handler]) => [prefix + path, handler]),
  );
  return async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const handler = handlersMap.get(path);

    if (!handler) {
      return new Response("Not found", { status: 404 });
    }

    const reqHeaders = request.headers;
    const resHeaders = new Headers();
    const response = await handler({ context: { url, reqHeaders, resHeaders }, request });

    response.headers.forEach((value, key) => {
      resHeaders.set(key, value);
    });

    return new Response(response.body, { status: response.status, headers: resHeaders });
  };
}
