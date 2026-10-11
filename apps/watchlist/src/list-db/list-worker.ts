import { createWsRemoteSource, getWorkerConfig, startDbWorker } from "@sqlite-sync/core/worker";
import { type ListDbProps, syncDbSchema } from "./migrations";

const workerConfig = await getWorkerConfig<ListDbProps>();

const syncUrl = new URL(`/list-db/list-db-server/list-${workerConfig.props.listId}`, import.meta.env.VITE_APP_URL);
syncUrl.protocol = syncUrl.protocol === "https:" ? "wss:" : "ws:";

await startDbWorker({
  workerConfig,
  syncDbSchema,
  verifySchema: import.meta.env.DEV,
  createRemoteSource: createWsRemoteSource({
    createWebSocket: () => new WebSocket(syncUrl),
  }),
});
