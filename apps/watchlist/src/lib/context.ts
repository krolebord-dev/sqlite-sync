import type { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export type Context = Env & z.infer<typeof envSchema>;

export const contextSymbol = Symbol("context");

export const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  TWITCH_CLIENT_ID: z.string(),
  TWITCH_CLIENT_SECRET: z.string(),
  AUTH_SECRET: z.string(),
  MODE: z.enum(["development", "production"]),
  VITE_APP_URL: z.string(),
  RESEND_API_KEY: z.string().optional(),
});

export const getContextStorage = () => {
  return (globalThis as any)[contextSymbol] as AsyncLocalStorage<Context>;
};

export function getContext(): Context;
export function getContext({ optional }: { optional?: true }): Context | null;
export function getContext(opts?: { optional?: true }): Context | null {
  const context = getContextStorage()?.getStore();
  if (context) {
    return context;
  }
  if (opts?.optional === true) {
    return null;
  }
  throw new Error("Context not found");
}
