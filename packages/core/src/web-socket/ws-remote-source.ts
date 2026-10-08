import type { SyncServerMessage, SyncServerRequest } from "../server";
import type { CreateRemoteSourceFactory } from "../sqlite-crdt/crdt-sync-remote-source";
import { createDeferredPromise, type DeferredPromise, jsonSafeParse } from "../utils";
import type { EventsPullRequest, EventsPushRequest, EventsPushResponse, GetEventsBatch } from "../worker";

type WsRemoteSourceConfig = {
  createWebSocket: () => Pick<WebSocket, "onmessage" | "close" | "addEventListener" | "removeEventListener"> & {
    readyState: number;
    send: (data: string) => void;
  };
};

export const createWsRemoteSource = ({ createWebSocket }: WsRemoteSourceConfig): CreateRemoteSourceFactory => {
  return async ({ onEventsAvailable, onReconnected, signal }) => {
    const socket = createWebSocket();

    const openPromise = createDeferredPromise<void>({
      timeout: 5000,
      onTimeout: () => {
        socket.close();
      },
    });
    socket.addEventListener("open", () => {
      openPromise.resolve(undefined);
    });
    const abortOpen = () => {
      socket.close();
      openPromise.reject(signal.reason);
    };
    signal.addEventListener("abort", abortOpen, { once: true });
    try {
      await openPromise.promise;
    } finally {
      signal.removeEventListener("abort", abortOpen);
    }

    socket.addEventListener("open", () => {
      onReconnected();
    });

    const waitForOpen = () =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) {
          resolve();
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onOpen = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          socket.removeEventListener("open", onOpen);
          reject(signal.reason);
        };
        socket.addEventListener("open", onOpen, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
      });

    const requestsMap = new Map<string, DeferredPromise<unknown>>();

    const pushEvents = async (request: EventsPushRequest): Promise<EventsPushResponse> => {
      await waitForOpen();
      const requestId = crypto.randomUUID();
      const promise = createDeferredPromise<EventsPushResponse>({
        timeout: 5000,
        onTimeout: () => requestsMap.delete(requestId),
      });
      requestsMap.set(requestId, promise as DeferredPromise<unknown>);

      const wsRequest: SyncServerRequest = {
        type: "push-events",
        requestId,
        nodeId: request.nodeId,
        events: request.events,
      };
      socket.send(JSON.stringify(wsRequest));

      return promise.promise;
    };

    const pullEvents = async (request: EventsPullRequest): Promise<GetEventsBatch> => {
      await waitForOpen();
      const requestId = crypto.randomUUID();
      const promise = createDeferredPromise<GetEventsBatch>({
        timeout: 2000,
        onTimeout: () => requestsMap.delete(requestId),
      });
      requestsMap.set(requestId, promise as DeferredPromise<unknown>);

      const wsRequest: SyncServerRequest = {
        type: "pull-events",
        requestId,
        afterSyncId: request.afterSyncId,
        excludeNodeId: request.excludeNodeId,
      };
      socket.send(JSON.stringify(wsRequest));

      return promise.promise;
    };

    socket.onmessage = (event) => {
      const result = jsonSafeParse<SyncServerMessage>(event.data);

      if (!result.success || !("type" in result.data) || !result.data.type) {
        return;
      }

      const message = result.data;

      switch (message.type) {
        case "events-pull-response": {
          const promise = requestsMap.get(message.requestId);
          if (!promise) {
            return;
          }
          promise.resolve(message.data);
          requestsMap.delete(message.requestId);
          break;
        }
        case "events-push-response": {
          const promise = requestsMap.get(message.requestId);
          if (!promise) {
            return;
          }
          promise.resolve(message.data);
          requestsMap.delete(message.requestId);
          break;
        }
        case "events-applied":
          onEventsAvailable({ newSyncId: message.newSyncId, remoteEventHlcSum: message.eventHlcSum });
          break;
        default:
          message satisfies never;
          return;
      }
    };

    return {
      pushEvents,
      pullEvents,
      disconnect: () => {
        socket.close();
      },
    };
  };
};
