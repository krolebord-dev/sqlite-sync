import {
  isWorkerInitMessage,
  syncDbWorkerLockName,
  type WorkerConfig,
} from "./worker-common";
import { createDeferredPromise } from "./utils";
import { WorkerProcessor } from "./worker-processor";
import { createSyncDbMigrations } from "./migrations/migrator";
import { seedMigration } from "./migrations/seed-migration";

const config = await getConfig();

const migrations = createSyncDbMigrations({
  1: seedMigration,
});

await navigator.locks.request(
  syncDbWorkerLockName,
  { mode: "exclusive" },
  async (lock) => {
    if (!lock) {
      return;
    }

    const processor = await WorkerProcessor.create(config, migrations);
    processor.postInitReady();

    await new Promise<void>(() => {});
  }
);

console.error("Failed to acquire lock");

async function getConfig(): Promise<WorkerConfig> {
  let configSet = false;
  const responsePromise = createDeferredPromise<WorkerConfig>();

  self.onmessage = (event: MessageEvent<unknown>) => {
    if (configSet) {
      console.error("Worker config already set");
      return;
    }

    const message = event.data;
    if (!isWorkerInitMessage(message)) {
      return;
    }

    responsePromise.resolve(message.config);
    configSet = true;
  };

  return responsePromise.promise;
}
