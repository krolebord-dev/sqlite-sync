import {
  createTypedEventTarget,
  createDeferredPromise,
  type DeferredPromise,
} from "../utils";
import {
  isWorkerInitResponse,
  isWorkerNotificationMessage,
  isWorkerResponseMessage,
} from "./worker-common";
import type {
  AsyncRpc,
  WorkerBroadcastChannels,
  WorkerConfig,
  WorkerInitMessage,
  WorkerNotificationMessage,
  WorkerRequestMessage,
  WorkerRequestMethod,
  WorkerResponseMessage,
  WorkerRpc,
} from "./worker-common";

export const createWorkerDbClient = ({
  broadcastChannels,
}: {
  broadcastChannels: WorkerBroadcastChannels;
}) => {
  const eventTarget = createTypedEventTarget<{
    "new-notification": WorkerNotificationMessage;
  }>();
  const workerRequestsMap = new Map<string, DeferredPromise<unknown>>();

  const queryWorker = <TMethod extends WorkerRequestMethod>(
    method: TMethod,
    args: Parameters<WorkerRpc[TMethod]>
  ): Promise<ReturnType<WorkerRpc[TMethod]>> => {
    // TODO Add timeout
    const requestId = crypto.randomUUID();
    const promise = createDeferredPromise<unknown>();
    workerRequestsMap.set(requestId, promise);

    const request: WorkerRequestMessage<TMethod> = {
      type: "request",
      requestId,
      method,
      args,
    };

    broadcastChannels.requests.postMessage(request);

    return promise.promise as Promise<ReturnType<WorkerRpc[TMethod]>>;
  };

  const handleWorkerResponse = (message: WorkerResponseMessage) => {
    const promise = workerRequestsMap.get(message.requestId);
    if (!promise) {
      return;
    }

    promise.resolve(message.data);
    workerRequestsMap.delete(message.requestId);
  };

  broadcastChannels.responses.onmessage = (event) => {
    const message = event.data;

    if (isWorkerResponseMessage(message)) {
      handleWorkerResponse(message);
    } else if (isWorkerNotificationMessage(message)) {
      eventTarget.dispatchEvent("new-notification", message);
    }
  };

  const rpc: AsyncRpc<WorkerRpc> = {
    execute: (query) => queryWorker("execute", [query]),
    getSnapshot: () => queryWorker("getSnapshot", []),
    pushTabEvents: (request) => queryWorker("pushTabEvents", [request]),
    pullEvents: (params) => queryWorker("pullEvents", [params]),
    postInitReady: () => queryWorker("postInitReady", []),
  };

  return {
    ...rpc,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };
};

export function initializeWorkerDb({
  worker,
  broadcastChannels,
  config,
}: {
  worker: Worker;
  broadcastChannels: WorkerBroadcastChannels;
  config: WorkerConfig;
}) {
  const promise = createDeferredPromise<void>();
  broadcastChannels.responses.onmessage = (event) => {
    const message = event.data;
    if (!isWorkerInitResponse(message)) {
      return;
    }
    promise.resolve();
    worker.onmessage = null;
  };

  const configMessage: WorkerInitMessage = {
    type: "init",
    config,
  };
  worker.postMessage(configMessage);

  broadcastChannels.requests.postMessage({
    type: "request",
    requestId: crypto.randomUUID(),
    method: "postInitReady",
    args: [],
  });

  return promise.promise;
}

