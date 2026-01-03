import {
  createDeferredPromise,
  type DeferredPromise,
  type EventsPullRequest,
  type EventsPushRequest,
  type EventsPushResponse,
  jsonSafeParse,
} from "@sqlite-sync/core";
import type { SyncServerMessage, SyncServerRequest } from "@sqlite-sync/core/server";
import { type GetEventsBatch, startDbWorker } from "@sqlite-sync/core/worker";
import { PartySocket } from "partysocket";
import { migrations } from "./migrations";

await startDbWorker({
  migrations,
  createRemoteSource: async ({ onEventsAvailable }) => {
    const socket = new PartySocket({
      host: "localhost:8787",
      party: "event-log-server",
      room: "main",
    });

    const openPromise = createDeferredPromise<void>({
      timeout: 5000,
      onTimeout: () => {
        socket.close();
      },
    });
    socket.addEventListener("open", () => {
      openPromise.resolve(undefined);
    });
    await openPromise.promise;

    const requestsMap = new Map<string, DeferredPromise<unknown>>();

    const pushEvents = async (request: EventsPushRequest): Promise<EventsPushResponse> => {
      const requestId = crypto.randomUUID();
      const promise = createDeferredPromise<EventsPushResponse>({ timeout: 5000 });
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
      const requestId = crypto.randomUUID();
      const promise = createDeferredPromise<GetEventsBatch>({ timeout: 2000 });
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
          onEventsAvailable(message.newSyncId);
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
  },
});
