import { z } from "zod";
import type { GetEventsBatch } from "../sqlite-crdt/crdt-storage";
import type { EventsPushResponse } from "../sqlite-crdt/crdt-sync-remote-source";

export const syncServerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pull-events"),
    requestId: z.string(),
    afterSyncId: z.number(),
    excludeNodeId: z.string().optional(),
  }),
  z.object({
    type: z.literal("push-events"),
    requestId: z.string(),
    nodeId: z.string(),
    events: z.array(
      z.object({
        timestamp: z.string(),
        type: z.enum(["item-created", "item-updated"]),
        dataset: z.string(),
        item_id: z.string(),
        payload: z.string(),
      }),
    ),
  }),
]);

export type SyncServerMessage =
  | {
      type: "events-pull-response";
      requestId: string;
      data: GetEventsBatch;
    }
  | {
      type: "events-push-response";
      requestId: string;
      data: EventsPushResponse;
    }
  | {
      type: "events-applied";
      newSyncId: number;
    };

export type SyncServerRequest = z.infer<typeof syncServerRequestSchema>;

export type ExtractSyncServerRequest<T extends SyncServerRequest["type"]> = Extract<SyncServerRequest, { type: T }>;
