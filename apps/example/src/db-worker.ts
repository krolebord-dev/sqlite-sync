import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { syncDbSchema } from "./migrations";

const syncUrl = new URL("/parties/event-log-server/main", import.meta.env.VITE_SYNC_URL || self.location.origin);
syncUrl.protocol = syncUrl.protocol === "https:" ? "wss:" : "ws:";

await startDbWorker({
  syncDbSchema,
  verifySchema: import.meta.env.DEV,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () => new WebSocket(syncUrl),
  }),
});
