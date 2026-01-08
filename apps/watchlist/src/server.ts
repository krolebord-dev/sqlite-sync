import { apiHandler } from "./api/api-handler";
import { orpcHandler } from "./orpc/orpc-router";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/rpc")) {
      const { matched, response } = await orpcHandler.handle(request, {
        prefix: "/rpc",
        context: {},
      });

      if (matched) {
        return response;
      }

      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api")) {
      return apiHandler(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
