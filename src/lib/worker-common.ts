import type { CrdtEventType } from "./migrations/system-schema";
import type { ExecuteParams, ExecuteResult } from "./sqlite-db-wrapper";

export const syncDbWorkerLockName = "sync-db-worker-lock";

export const syncDbWorkerSharedLockName = "sync-db-worker-shared-lock";

export type PendingCrdtEvent = {
  id: string;
  timestamp: string;
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
  node_id: string;
};

export type AppliedCrdtEvent = PendingCrdtEvent & {
  sync_id: number;
};

export type WorkerNotificationMessage = {
  notificationType: "new-event-applied";
  event: AppliedCrdtEvent;
};

type PullEventsParams = {
  startFromSyncId: number;
  excludeNodeId: string;
};

export type PullEventsResponse = {
  newSyncId: number;
  events: AppliedCrdtEvent[];
};

export type GetSnapshotResponse = {
  file: Uint8Array<ArrayBufferLike>;
  syncId: number;
};

export interface WorkerRpc {
  getSnapshot: () => GetSnapshotResponse;
  pushLocalEvents: (
    nodeId: string,
    events: Omit<PendingCrdtEvent, "node_id">[]
  ) => void;
  execute: (query: ExecuteParams) => ExecuteResult<unknown>;
  pullEvents: (params: PullEventsParams) => PullEventsResponse;
}

export type WorkerRequestMethod = keyof WorkerRpc;

export type WorkerRequestMessage<
  TMethod extends WorkerRequestMethod = WorkerRequestMethod
> = {
  type: "request";
  requestId: string;
  method: TMethod;
  args: Parameters<WorkerRpc[TMethod]>;
};

export type WorkerResponseMessage<
  TMethod extends WorkerRequestMethod = WorkerRequestMethod
> = {
  type: "response";
  requestId: string;
  data: ReturnType<WorkerRpc[TMethod]>;
};

export type AsyncRpc<T> = {
  [K in keyof T]: T[K] extends (...args: infer U) => infer V
    ? (...args: U) => V extends Promise<infer W> ? Promise<W> : Promise<V>
    : never;
};

export const broadcastChannelNames = {
  requests: "sync-db-worker-requests",
  responses: "sync-db-worker-responses",
} as const;

export type WorkerBroadcastChannels = {
  requests: BroadcastChannel;
  responses: BroadcastChannel;
};

export const createBroadcastChannels = (): WorkerBroadcastChannels => {
  return {
    requests: new BroadcastChannel(broadcastChannelNames.requests),
    responses: new BroadcastChannel(broadcastChannelNames.responses),
  };
};

export type WorkerConfig = {
  dbPath: string;
  nodeId: string;
  clearOnInit?: boolean;
};

export type WorkerInitMessage = {
  type: "init";
  config: WorkerConfig;
};

export function isWorkerInitMessage(
  message: unknown
): message is WorkerInitMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "init"
  );
}

export type WorkerInitResponse = {
  type: "init-ready";
};

export function isWorkerInitResponse(
  message: unknown
): message is WorkerInitResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "init-ready"
  );
}

export function isWorkerRequestMessage(
  message: unknown
): message is WorkerRequestMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "request"
  );
}

export function isWorkerResponseMessage(
  message: unknown
): message is WorkerResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    "requestId" in message &&
    "data" in message
  );
}

export function isWorkerNotificationMessage(
  message: unknown
): message is WorkerNotificationMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "notificationType" in message &&
    !!message.notificationType
  );
}
