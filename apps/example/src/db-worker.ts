import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { syncDbSchema } from "./migrations";

await startDbWorker({
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: "localhost:8787",
        party: "event-log-server",
        room: "main",
      }),
  }),
});
