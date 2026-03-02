import type { ServerSyncDb } from "@sqlite-sync/cloudflare";
import { createDefineJob } from "@sqlite-sync/cloudflare/jobs";
import type { UserSyncDbSchema } from "../migrations";

export type UserDbJobContext = {
  ctx: DurableObjectState;
  env: Env;
  syncDb: ServerSyncDb<UserSyncDbSchema>;
};

export const defineJob = createDefineJob<UserDbJobContext>();
