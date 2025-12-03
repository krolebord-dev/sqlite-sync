import {
  isWorkerInitMessage,
  syncDbWorkerLockName,
  type WorkerConfig,
  type WorkerInitResponse,
} from "./worker-common";
import { createDeferredPromise } from "./utils";
import { WorkerProcessor } from "./worker-processor";
import { createSyncDbMigrations } from "./migrations/migrator";
import { systemMigration } from "./migrations/system-schema";
import { seedMigration } from "./migrations/seed-migration";

const config = await getConfig();

const migrations = createSyncDbMigrations({
  0: systemMigration,
  1: seedMigration,
});

let awaitingReady = true;
while (true) {
  console.log("requesting lock", awaitingReady);
  await navigator.locks.request(
    syncDbWorkerLockName,
    { mode: "exclusive", ifAvailable: awaitingReady },
    async (lock) => {
      if (!lock) {
        const response: WorkerInitResponse = {
          type: "init-ready",
        };
        self.postMessage(response);

        awaitingReady = false;
        return;
      }

      await WorkerProcessor.create(config, migrations);

      const response: WorkerInitResponse = {
        type: "init-ready",
      };
      self.postMessage(response);

      await new Promise<void>(() => {});
    }
  );
}

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
