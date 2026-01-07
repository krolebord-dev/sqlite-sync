import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { handleGoogleCallback } from "@/lib/auth";

const schema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().nullable().optional(),
});

export const Route = createFileRoute("/api/auth/callback/google")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const searchParams = new URL(request.url).searchParams;
        const data = schema.parse({
          code: searchParams.get("code"),
          state: searchParams.get("state"),
          error: searchParams.get("error"),
        });

        if (data.error || !data.code || !data.state) {
          return redirect({ to: "/sign-in" });
        }

        const result = await handleGoogleCallback({ code: data.code, state: data.state });

        return result.success ? redirect({ to: "/" }) : redirect({ to: "/sign-in" });
      },
    },
  },
});
