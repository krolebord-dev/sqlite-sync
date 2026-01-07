import "@/lib/register-context";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { type Context, envSchema, getContextStorage } from "./lib/context";

export default createServerEntry({
  fetch(request, env) {
    envSchema.parse(env);
    return getContextStorage().run(env as Context, () => {
      return handler.fetch(request);
    });
  },
});
