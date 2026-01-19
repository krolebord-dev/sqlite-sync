import { createWsRemoteSource, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { migrations } from "./migrations";

await startDbWorker({
  migrations,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: "localhost:8787",
        party: "event-log-server",
        room: "main",
      }),
  }),
});
