import { startDbWorker } from "@sqlite-sync/core/worker";
import {
  jsonSafeParse,
  createDeferredPromise,
  type DeferredPromise,
} from "@sqlite-sync/core";
import type {
  SyncServerMessage,
  SyncServerRequest,
} from "@sqlite-sync/core/server";
import type {
  EventsPullRequest,
  EventsPullResponse,
  EventsPushRequest,
  EventsPushResponse,
} from "@sqlite-sync/core/worker";
import { listItemsMigration } from "./migrations";

// TODO Pass props from client to worker
// Get sync server config from URL parameters
const urlParams = new URLSearchParams(self.location.search);
const listId = urlParams.get("listId");
const sessionId = urlParams.get("sessionId");

await startDbWorker({
  migrations: {
    1: listItemsMigration,
  },
  createRemoteSource:
    listId && sessionId
      ? ({ onEventsAvailable }) => {
          // Construct WebSocket URL for the list sync server
          const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${protocol}//${self.location.host}/ws/list-sync/${listId}?sessionId=${sessionId}`;

          let socket: WebSocket | null = null;
          const requestsMap = new Map<string, DeferredPromise<unknown>>();

          const connect = () => {
            socket = new WebSocket(wsUrl);

            socket.onmessage = (event) => {
              const result = jsonSafeParse<SyncServerMessage>(event.data);

              if (
                result.status !== "ok" ||
                !("type" in result.data) ||
                !result.data.type
              ) {
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
                  return;
              }
            };

            socket.onerror = (error) => {
              console.error("WebSocket error:", error);
            };

            socket.onclose = () => {
              // Attempt to reconnect after a delay
              setTimeout(connect, 3000);
            };
          };

          connect();

          const pushEvents = async (
            request: EventsPushRequest
          ): Promise<EventsPushResponse> => {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return { ok: false };
            }

            const requestId = crypto.randomUUID();
            const promise = createDeferredPromise<EventsPushResponse>();
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

          const pullEvents = async (
            request: EventsPullRequest
          ): Promise<EventsPullResponse> => {
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return {
                events: [],
                hasMore: false,
                newSyncId: request.afterSyncId,
              };
            }

            const requestId = crypto.randomUUID();
            const promise = createDeferredPromise<EventsPullResponse>();
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

          return {
            pushEvents,
            pullEvents,
          };
        }
      : undefined,
});
