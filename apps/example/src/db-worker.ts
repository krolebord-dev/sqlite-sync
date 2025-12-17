import { startDbWorker } from "@sqlite-sync/core/worker";
import { seedMigration } from "./seed-migration";

await startDbWorker({
  migrations: {
    1: seedMigration,
  },
  // createRemoteSource: ({ onEventsAvailable }) => {
  //   const socket = new PartySocket({
  //     host: "localhost:8787",
  //     party: "event-log-server",
  //     room: "main",
  //   });

  //   const requestsMap = new Map<string, DeferredPromise<unknown>>();

  //   const pushEvents = async (
  //     request: EventsPushRequest
  //   ): Promise<EventsPushResponse> => {
  //     // TODO Add timeout
  //     const requestId = crypto.randomUUID();
  //     const promise = createDeferredPromise<EventsPushResponse>();
  //     requestsMap.set(requestId, promise as DeferredPromise<unknown>);

  //     const wsRequest: SyncServerRequest = {
  //       type: "push-events",
  //       requestId,
  //       nodeId: request.nodeId,
  //       events: request.events,
  //     };
  //     socket.send(JSON.stringify(wsRequest));

  //     return promise.promise;
  //   };

  //   const pullEvents = async (
  //     request: EventsPullRequest
  //   ): Promise<EventsPullResponse> => {
  //     // TODO Add timeout
  //     const requestId = crypto.randomUUID();
  //     const promise = createDeferredPromise<EventsPullResponse>();
  //     requestsMap.set(requestId, promise as DeferredPromise<unknown>);

  //     const wsRequest: SyncServerRequest = {
  //       type: "pull-events",
  //       requestId,
  //       afterSyncId: request.afterSyncId,
  //       excludeNodeId: request.excludeNodeId,
  //     };
  //     socket.send(JSON.stringify(wsRequest));

  //     return promise.promise;
  //   };

  //   socket.onmessage = (event) => {
  //     const result = jsonSafeParse<SyncServerMessage>(event.data);

  //     if (
  //       result.status !== "ok" ||
  //       !("type" in result.data) ||
  //       !result.data.type
  //     ) {
  //       return;
  //     }

  //     const message = result.data;

  //     switch (message.type) {
  //       case "events-pull-response": {
  //         const promise = requestsMap.get(message.requestId);
  //         if (!promise) {
  //           return;
  //         }
  //         promise.resolve(message.data);
  //         requestsMap.delete(message.requestId);
  //         break;
  //       }
  //       case "events-push-response": {
  //         const promise = requestsMap.get(message.requestId);
  //         if (!promise) {
  //           return;
  //         }
  //         promise.resolve(message.data);
  //         requestsMap.delete(message.requestId);
  //         break;
  //       }
  //       case "events-applied":
  //         onEventsAvailable(message.newSyncId);
  //         break;
  //       default:
  //         message satisfies never;
  //         return;
  //     }
  //   };

  //   return {
  //     pushEvents,
  //     pullEvents,
  //   };
  // },
});
