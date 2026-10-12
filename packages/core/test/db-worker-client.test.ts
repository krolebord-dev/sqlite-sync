import { describe, expect, it, vi } from "vitest";
import { createWorkerDbClient } from "../src/worker-db/db-worker-client";
import { createBroadcastChannels } from "../src/worker-db/worker-common";

describe("worker client request cleanup", () => {
  const setup = async () => {
    const dbId = `worker-client-test-${crypto.randomUUID()}`;
    const channels = createBroadcastChannels(dbId);
    const workerChannels = createBroadcastChannels(dbId);
    const worker = Object.assign(new EventTarget(), {
      onerror: null,
      onmessage: null,
      onmessageerror: null,
      postMessage: () =>
        workerChannels.responses.postMessage({
          notificationType: "state-changed",
          state: { remoteState: "offline", deSynced: false, schemaVersionMismatched: false },
          storageGeneration: "gen-1",
        }),
      terminate: () => {},
    }) satisfies Worker;
    const client = await createWorkerDbClient({
      broadcastChannels: channels,
      worker,
      config: { dbId, clientId: "client", props: undefined },
    });
    return {
      channels,
      client,
      dispose: () => {
        client.dispose();
        channels.requests.close();
        channels.responses.close();
        workerChannels.requests.close();
        workerChannels.responses.close();
      },
    };
  };

  it("rejects failed request sends without leaving a timer running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connection = await setup();
    try {
      const pendingTimers = vi.getTimerCount();
      connection.channels.requests.close();
      await expect(connection.client.getSnapshot()).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(pendingTimers);
    } finally {
      connection.dispose();
      vi.useRealTimers();
    }
  });
});
