import { createWsRemoteSource, getWorkerConfig, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { syncDbSchema, type UserDbProps } from "./migrations";

const workerConfig = await getWorkerConfig<UserDbProps>();

await startDbWorker({
  workerConfig,
  syncDbSchema,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () =>
      new PartySocket({
        host: import.meta.env.VITE_APP_URL,
        prefix: "user-db",
        party: "user-db-server",
        room: `user-${workerConfig.props.userId}`,
      }),
  }),
});
