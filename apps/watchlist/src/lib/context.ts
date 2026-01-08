import { env } from "cloudflare:workers";
import { z } from "zod";

export type Context = Env & z.infer<typeof envSchema>;

const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  TWITCH_CLIENT_ID: z.string(),
  TWITCH_CLIENT_SECRET: z.string(),
  AUTH_SECRET: z.string(),
  MODE: z.enum(["development", "production"]),
  VITE_APP_URL: z.string(),
  RESEND_API_KEY: z.string().optional(),
});
envSchema.parse(env);

export function getContext(): Context {
  return env;
}
