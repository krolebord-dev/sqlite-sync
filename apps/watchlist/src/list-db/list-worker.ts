import { createWsRemoteSource, getWorkerConfig, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { type ListDbProps, syncDbSchema } from "./migrations";

const workerConfig = await getWorkerConfig<ListDbProps>();

await startDbWorker({
  workerConfig,
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: "localhost:3000",
        prefix: "list-db",
        party: "list-db-server",
        room: `list-${workerConfig.props.listId}`,
      }),
  }),
});
