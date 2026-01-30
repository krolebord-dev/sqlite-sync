import { z } from "zod";
import type { EventsPushResponse } from "../sqlite-crdt/crdt-sync-remote-source";
import type { EventsPullResponse } from "../worker-db/worker-common";

const pullEventsZodSchema = z.object({
  type: z.literal("pull-events"),
  requestId: z.string(),
  afterSyncId: z.number(),
  excludeNodeId: z.string().optional(),
});
const hlcTimestampPattern = /^\d{15}:[0-9a-z]{5}:.+$/;
const safeIdentifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const pushEventsZodSchema = z.object({
  type: z.literal("push-events"),
  requestId: z.string(),
  nodeId: z.string(),
  events: z.array(
    z.object({
      schema_version: z.number().int().nonnegative(),
      timestamp: z.string().regex(hlcTimestampPattern, "Invalid HLC timestamp format"),
      type: z.enum(["item-created", "item-updated"]),
      dataset: z.string().regex(safeIdentifierPattern, "Invalid dataset identifier"),
      item_id: z.string().min(1),
      payload: z.string().refine(
        (val) => {
          try {
            JSON.parse(val);
            return true;
          } catch {
            return false;
          }
        },
        { message: "Payload must be valid JSON" },
      ),
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
