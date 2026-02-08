import { env } from "cloudflare:workers";
import { z } from "zod";
import { handleGoogleCallback } from "@/orpc/routers/auth.router";
import type { ApiHandler } from "../api-handler";

const schema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().nullable().optional(),
});

export const googleCallbackHandler: ApiHandler = async ({ request, context }) => {
  const searchParams = new URL(request.url).searchParams;
  const data = schema.parse({
    code: searchParams.get("code"),
    state: searchParams.get("state"),
    error: searchParams.get("error"),
  });

  if (data.error || !data.code || !data.state) {
    return Response.redirect("/sign-in", 302);
  }

  const result = await handleGoogleCallback(context, { code: data.code, state: data.state });

  return result.success
    ? Response.redirect(`${env.VITE_APP_URL}/`, 302)
    : Response.redirect(`${env.VITE_APP_URL}/sign-in`, 302);
};
