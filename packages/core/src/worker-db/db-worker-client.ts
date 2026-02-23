import {
  createDeferredPromise,
  createTypedEventTarget,
  type DeferredPromise,
  type TypedEvent,
  type TypedEventTarget,
} from "../utils";
import type {
  AsyncRpc,
  WorkerBroadcastChannels,
  WorkerConfig,
  WorkerErrorResponseMessage,
  WorkerInitMessage,
  WorkerNotificationMessage,
  WorkerRequestMessage,
  WorkerRequestMethod,
  WorkerResponseMessage,
  WorkerRpc,
  WorkerState,
} from "./worker-common";
import { isWorkerErrorResponseMessage, isWorkerNotificationMessage, isWorkerResponseMessage } from "./worker-common";

type NotificationEvents = {
  [K in WorkerNotificationMessage["notificationType"]]: Extract<WorkerNotificationMessage, { notificationType: K }>;
};

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

  const queryWorker = <TMethod extends WorkerRequestMethod>(
    method: TMethod,
    args: Parameters<WorkerRpc[TMethod]>,
  ): Promise<Awaited<ReturnType<WorkerRpc[TMethod]>>> => {
    const requestId = crypto.randomUUID();
    const promise = createDeferredPromise<unknown>({
      timeout: 30_000,
      onTimeout: () => workerRequestsMap.delete(requestId),
    });
    workerRequestsMap.set(requestId, promise);

    const request: WorkerRequestMessage<TMethod> = {
      type: "request",
      requestId,
      method,
      args,
    };

    broadcastChannels.requests.postMessage(request);

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
    pushTabEvents: (request) => queryWorker("pushTabEvents", [request]),
    pullEvents: (params) => queryWorker("pullEvents", [params]),
    postState: () => queryWorker("postState", []),
    goOnline: () => queryWorker("goOnline", []),
    goOffline: () => queryWorker("goOffline", []),
  };

  const statePromise = awaitWorkerState(eventTarget);
  postWorkerConfig(worker, config);
  rpc.postState();

  let workerState = await statePromise;

  eventTarget.addEventListener("state-changed", (event) => {
    workerState = event.payload.state;
  });

  return {
    ...rpc,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
    getState: () => workerState,
  };
};

function awaitWorkerState(eventTarget: TypedEventTarget<NotificationEvents>) {
  const promise = createDeferredPromise<WorkerState>({ timeout: 15_000 });

  const onStateChanged = (
    event: TypedEvent<Extract<WorkerNotificationMessage, { notificationType: "state-changed" }>>,
  ) => {
    promise.resolve(event.payload.state);
    eventTarget.removeEventListener("state-changed", onStateChanged);
  };

  eventTarget.addEventListener("state-changed", onStateChanged);

  return promise.promise;
}

function postWorkerConfig(worker: Worker, config: WorkerConfig) {
  const configMessage: WorkerInitMessage = {
    type: "init",
    config,
  };
  worker.postMessage(configMessage);
}
