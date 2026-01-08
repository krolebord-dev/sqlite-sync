import { startDbWorker } from "@sqlite-sync/core/worker";
import { migrations } from "./migrations";

await startDbWorker({
  migrations,
});
