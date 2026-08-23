import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { syncDbSchema } from "./migrations";

await startDbWorker({
  syncDbSchema,
  verifySchema: import.meta.env.DEV,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: import.meta.env.VITE_SYNC_URL || self.location.origin,
        party: "event-log-server",
        room: "main",
      }),
  }),
});
