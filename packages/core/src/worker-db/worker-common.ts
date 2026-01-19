import type { EventsPullRequest, EventsPushRequest, EventsPushResponse } from "../sqlite-crdt/crdt-sync-remote-source";
import type { CrdtEventType } from "../sqlite-crdt/crdt-table-schema";
import type { ExecuteParams, ExecuteResult } from "../sqlite-db-wrapper";
import { TypedBroadcastChannel } from "../utils";

export const syncDbWorkerLockName = "sync-db-worker-lock";

export type WorkerNotificationMessage =
  | {
      notificationType: "new-event-chunk-applied";
      newSyncId: number;
    }
  | {
      notificationType: "state-changed";
      state: WorkerState;
    };

export type WorkerState = {
  remoteState: "online" | "offline" | "pending";
};

export type PushTabEventsResponse = {
  firstEventSyncId: number;
  lastEventSyncId: number;
};

export type GetSnapshotResponse = {
  file: Uint8Array<ArrayBufferLike>;
  syncId: number;
  schemaVersion: number;
};

export type EventsPullResponse = {
  events: {
    schema_version: number;
    type: CrdtEventType;
    timestamp: string;
    dataset: string;
    item_id: string;
    payload: string;
  }[];
  hasMore: boolean;
  nextSyncId: number;
};

export interface WorkerRpc {
  getSnapshot: () => GetSnapshotResponse;
  pushTabEvents: (request: EventsPushRequest) => EventsPushResponse;
  execute: (query: ExecuteParams) => ExecuteResult<unknown>;
  pullEvents: (params: EventsPullRequest) => EventsPullResponse;
  postState: () => void;
  goOnline: () => Promise<void>;
  goOffline: () => void;
}

export type WorkerRequestMethod = keyof WorkerRpc;

export type WorkerRequestMessage<TMethod extends WorkerRequestMethod = WorkerRequestMethod> = {
  type: "request";
  requestId: string;
  method: TMethod;
  args: Parameters<WorkerRpc[TMethod]>;
};

export type WorkerResponseMessage<TMethod extends WorkerRequestMethod = WorkerRequestMethod> = {
  type: "response";
  requestId: string;
  data: ReturnType<WorkerRpc[TMethod]>;
};

export type AsyncRpc<T> = {
  [K in keyof T]: T[K] extends (...args: infer U) => infer V ? (...args: U) => Promise<Awaited<V>> : never;
};

export const broadcastChannelNames = {
  requests: "sync-db-worker-requests",
  responses: "sync-db-worker-responses",
} as const;

export type WorkerBroadcastChannels = {
  requests: TypedBroadcastChannel<WorkerRequestMessage>;
  responses: TypedBroadcastChannel<WorkerResponseMessage | WorkerNotificationMessage>;
};

export const createBroadcastChannels = (prefix: string): WorkerBroadcastChannels => {
  return {
    requests: new TypedBroadcastChannel(`${prefix}-${broadcastChannelNames.requests}`),
    responses: new TypedBroadcastChannel(`${prefix}-${broadcastChannelNames.responses}`),
  };
};

export type WorkerConfig<Props = any> = {
  dbId: string;
  clientId: string;
  clearOnInit?: boolean;
  props: Props;
};

export type WorkerInitMessage = {
  type: "init";
  config: WorkerConfig;
};

export function isWorkerInitMessage(message: unknown): message is WorkerInitMessage {
  return typeof message === "object" && message !== null && "type" in message && message.type === "init";
}

export function isWorkerRequestMessage(message: unknown): message is WorkerRequestMessage {
  return typeof message === "object" && message !== null && "type" in message && message.type === "request";
}

export function isWorkerResponseMessage(message: unknown): message is WorkerResponseMessage {
  return (
    typeof message === "object" && message !== null && "type" in message && "requestId" in message && "data" in message
  );
}

export function isWorkerNotificationMessage(message: unknown): message is WorkerNotificationMessage {
  return typeof message === "object" && message !== null && "notificationType" in message && !!message.notificationType;
}
