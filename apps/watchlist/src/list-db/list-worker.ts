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
        host: import.meta.env.VITE_APP_URL,
        prefix: "list-db",
        party: "list-db-server",
        room: `list-${workerConfig.props.listId}`,
      }),
  }),
});
