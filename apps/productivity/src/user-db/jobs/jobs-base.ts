import type { ServerSyncDb } from "@sqlite-sync/cloudflare";
import { createDefineJob } from "do-jobs";
import type { UserSyncDbSchema } from "../migrations";

export type UserDbJobContext = {
  ctx: DurableObjectState;
  env: Env;
  syncDb: ServerSyncDb<UserSyncDbSchema>;
};

export const defineJob = createDefineJob<UserDbJobContext>();
