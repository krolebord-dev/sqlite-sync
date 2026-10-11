import type { SyncServerMessage, SyncServerRequest } from "../server";
import type { CreateRemoteSourceFactory } from "../sqlite-crdt/crdt-sync-remote-source";
import { createDeferredPromise, type DeferredPromise, type DistributiveOmit, jsonSafeParse } from "../utils";
import type { EventsPullRequest, EventsPushRequest, EventsPushResponse, GetEventsBatch } from "../worker";

const WS_OPEN = 1;

type WsRemoteSourceConfig = {
  createWebSocket: () => Pick<WebSocket, "onmessage" | "close" | "addEventListener" | "removeEventListener"> & {
    readyState: number;
    send: (data: string) => void;
  };
};

export const createWsRemoteSource = ({ createWebSocket }: WsRemoteSourceConfig): CreateRemoteSourceFactory => {
  return ({ onEventsAvailable, onClosed }) => {
    const socket = createWebSocket();
    const opened = createDeferredPromise<void>();
    opened.promise.catch(() => {});
    const requestsMap = new Map<string, DeferredPromise<unknown>>();
    let closed = false;

    const shutdown = () => {
      if (closed) {
        return false;
      }
      closed = true;
      const error = new Error("WebSocket closed");
      opened.reject(error);
      for (const request of requestsMap.values()) {
        request.reject(error);
      }
      requestsMap.clear();
      socket.close();
      return true;
    };

    if (socket.readyState === WS_OPEN) {
      opened.resolve();
    }
    socket.addEventListener("open", () => {
      opened.resolve();
    });
    // Closing on the first drop stops wrappers like PartySocket from reconnecting behind the library's back.
    socket.addEventListener("close", () => {
      if (shutdown()) {
        onClosed();
      }
    });

    const send = async <T>(request: DistributiveOmit<SyncServerRequest, "requestId">): Promise<T> => {
      await opened.promise;
      if (closed) {
        throw new Error("WebSocket closed");
      }
      const requestId = crypto.randomUUID();
      const promise = createDeferredPromise<T>();
      requestsMap.set(requestId, promise as DeferredPromise<unknown>);
      socket.send(JSON.stringify({ ...request, requestId }));
      return promise.promise;
    };

    const pushEvents = (request: EventsPushRequest) =>
      send<EventsPushResponse>({ type: "push-events", nodeId: request.nodeId, events: request.events });

    const pullEvents = (request: EventsPullRequest) =>
      send<GetEventsBatch>({
        type: "pull-events",
        afterSyncId: request.afterSyncId,
        excludeNodeId: request.excludeNodeId,
      });

    socket.onmessage = (event) => {
      const result = jsonSafeParse<SyncServerMessage>(event.data);

      if (!result.success || !("type" in result.data) || !result.data.type) {
        return;
      }

      const message = result.data;

      switch (message.type) {
        case "events-pull-response":
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
        shutdown();
      },
    };
  };
};
