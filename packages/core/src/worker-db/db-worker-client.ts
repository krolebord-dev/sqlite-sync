import {
  createDeferredPromise,
  createTypedEventTarget,
  type DeferredPromise,
  noop,
  type TypedEventTarget,
} from "../utils";
import type {
  AsyncRpc,
  WorkerBroadcastChannels,
  WorkerConfig,
  WorkerErrorResponseMessage,
  WorkerInitMessage,
  WorkerNotificationEvents,
  WorkerRequestMessage,
  WorkerRequestMethod,
  WorkerResponseMessage,
  WorkerRpc,
} from "./worker-common";
import { isWorkerErrorResponseMessage, isWorkerNotificationMessage, isWorkerResponseMessage } from "./worker-common";

type NotificationEvents = WorkerNotificationEvents;

export const createWorkerDbClient = async ({
  broadcastChannels,
  worker,
  config,
}: {
  broadcastChannels: WorkerBroadcastChannels;
  worker: Worker;
  config: WorkerConfig;
}) => {
  const eventTarget = createTypedEventTarget<NotificationEvents>();
  const workerRequestsMap = new Map<string, DeferredPromise<unknown>>();
  let isDisposed = false;

  const queryWorker = <TMethod extends WorkerRequestMethod>(
    method: TMethod,
    args: Parameters<WorkerRpc[TMethod]>,
  ): Promise<Awaited<ReturnType<WorkerRpc[TMethod]>>> => {
    if (isDisposed) {
      return Promise.reject(new Error("Worker client disposed"));
    }
    const requestId = crypto.randomUUID();
    const request: WorkerRequestMessage<TMethod> = {
      type: "request",
      requestId,
      method,
      args,
    };

    try {
      broadcastChannels.requests.postMessage(request);
    } catch (error) {
      return Promise.reject(error);
    }

    const promise = createDeferredPromise<unknown>({
      timeout: 30_000,
      onTimeout: () => workerRequestsMap.delete(requestId),
    });
    workerRequestsMap.set(requestId, promise);

    return promise.promise as Promise<Awaited<ReturnType<WorkerRpc[TMethod]>>>;
  };

  const handleWorkerResponse = (message: WorkerResponseMessage) => {
    const promise = workerRequestsMap.get(message.requestId);
    if (!promise) {
      return;
    }

    promise.resolve(message.data);
    workerRequestsMap.delete(message.requestId);
  };

  const handleWorkerError = (message: WorkerErrorResponseMessage) => {
    const promise = workerRequestsMap.get(message.requestId);
    if (!promise) {
      return;
    }

    promise.reject(new Error(message.error));
    workerRequestsMap.delete(message.requestId);
  };

  broadcastChannels.responses.onmessage = (event) => {
    const message = event.data;

    if (isWorkerResponseMessage(message)) {
      handleWorkerResponse(message);
    } else if (isWorkerErrorResponseMessage(message)) {
      handleWorkerError(message);
    } else if (isWorkerNotificationMessage(message)) {
      eventTarget.dispatchEvent(message.notificationType, message);
    }
  };

  const rpc: AsyncRpc<WorkerRpc> = {
    execute: (query) => queryWorker("execute", [query]),
    getSnapshot: () => queryWorker("getSnapshot", []),
    importData: (data, opts) => queryWorker("importData", [data, opts]),
    pushTabEvents: (request) => queryWorker("pushTabEvents", [request]),
    pullEvents: (params) => queryWorker("pullEvents", [params]),
    postState: () => queryWorker("postState", []),
    goOnline: () => queryWorker("goOnline", []),
    goOffline: () => queryWorker("goOffline", []),
    dropConnection: () => queryWorker("dropConnection", []),
    sync: () => queryWorker("sync", []),
    requestReload: (options) => queryWorker("requestReload", [options]),
  };

  const dispose = () => {
    isDisposed = true;
    broadcastChannels.responses.onmessage = null;
    for (const [id, deferred] of workerRequestsMap) {
      deferred.reject(new Error("Worker client disposed"));
      workerRequestsMap.delete(id);
    }
  };

  try {
    postWorkerConfig(worker, config);
    // On first tab, the worker may not have its BroadcastChannel listener ready yet,
    // so this request can be silently dropped and timeout. The worker will independently
    // post state at the end of init. For subsequent tabs, this triggers the already-running
    // worker to send its current state.
    rpc.postState().catch(noop);

    let { state: workerState, storageGeneration } = await awaitWorkerState(eventTarget);

    eventTarget.addEventListener("state-changed", (event) => {
      workerState = event.payload.state;
      storageGeneration = event.payload.storageGeneration;
    });

    return {
      ...rpc,
      subscribe: eventTarget.addEventListener,
      getState: () => workerState,
      getStorageGeneration: () => storageGeneration,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};

function awaitWorkerState(eventTarget: TypedEventTarget<NotificationEvents>) {
  const promise = createDeferredPromise<NotificationEvents["state-changed"]>({ timeout: 15_000 });

  const subscription = eventTarget.addEventListener("state-changed", (event) => {
    promise.resolve(event.payload);
    subscription.unsubscribe();
  });

  return promise.promise;
}

function postWorkerConfig(worker: Worker, config: WorkerConfig) {
  const configMessage: WorkerInitMessage = {
    type: "init",
    config,
  };
  worker.postMessage(configMessage);
}
