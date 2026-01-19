import { z } from "zod";
import type { EventsPushResponse } from "../sqlite-crdt/crdt-sync-remote-source";
import type { EventsPullResponse } from "../worker-db/worker-common";

const pullEventsZodSchema = z.object({
  type: z.literal("pull-events"),
  requestId: z.string(),
  afterSyncId: z.number(),
  excludeNodeId: z.string().optional(),
});
const pushEventsZodSchema = z.object({
  type: z.literal("push-events"),
  requestId: z.string(),
  nodeId: z.string(),
  events: z.array(
    z.object({
      schema_version: z.number(),
      timestamp: z.string(),
      type: z.enum(["item-created", "item-updated"]),
      dataset: z.string(),
      item_id: z.string(),
      payload: z.string(),
    }),
  ),
});

export const syncServerZodSchema = {
  pullEvents: pullEventsZodSchema,
  pushEvents: pushEventsZodSchema,
  request: z.discriminatedUnion("type", [pullEventsZodSchema, pushEventsZodSchema]),
};

export type SyncServerMessage =
  | {
      type: "events-pull-response";
      requestId: string;
      data: EventsPullResponse;
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

export type SyncServerRequest = z.infer<typeof syncServerZodSchema.request>;

export type ExtractSyncServerRequest<T extends SyncServerRequest["type"]> = Extract<SyncServerRequest, { type: T }>;
