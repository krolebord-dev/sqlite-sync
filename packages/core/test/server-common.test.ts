import { describe, expect, it } from "vitest";
import { syncServerZodSchema } from "../src/server/server-common";
import { MAX_PUSH_EVENTS, PUSH_BATCH_SIZE } from "../src/sqlite-crdt/crdt-sync-remote-source";

const pushRequest = (eventCount: number) => ({
  type: "push-events",
  requestId: "request",
  nodeId: "node",
  events: Array.from({ length: eventCount }, (_, index) => ({
    schema_version: 0,
    timestamp: `000000000001000:${String(index).padStart(5, "0")}:node`,
    type: "item-created",
    dataset: "_todo",
    item_id: `todo-${index}`,
    payload: "{}",
  })),
});

describe("syncServerZodSchema", () => {
  it("rejects pushes with more than MAX_PUSH_EVENTS events", () => {
    expect(syncServerZodSchema.request.safeParse(pushRequest(MAX_PUSH_EVENTS)).success).toBe(true);
    expect(syncServerZodSchema.request.safeParse(pushRequest(MAX_PUSH_EVENTS + 1)).success).toBe(false);
  });

  it("accepts snapshot pulls", () => {
    const request = { type: "pull-snapshot", requestId: "request" };
    const cursor = { dataset: "_todo", afterId: "todo-1" };
    expect(syncServerZodSchema.request.safeParse({ ...request, cursor: null }).success).toBe(true);
    expect(syncServerZodSchema.request.safeParse({ ...request, cursor }).data).toEqual({ ...request, cursor });
    expect(syncServerZodSchema.request.safeParse(request).success).toBe(false);
  });

  // Clients find out what a server supports by sending new fields on requests it already knows.
  it("ignores request fields it does not know", () => {
    const pull = { type: "pull-events", requestId: "request", afterSyncId: -1 };
    expect(syncServerZodSchema.request.safeParse({ ...pull, acceptSnapshot: true }).data).toEqual({
      ...pull,
      acceptSnapshot: true,
    });
    expect(syncServerZodSchema.request.safeParse({ ...pull, fromLaterVersion: true }).data).toEqual(pull);
  });

  it("accepts the batch size clients push", () => {
    expect(PUSH_BATCH_SIZE).toBeLessThanOrEqual(MAX_PUSH_EVENTS);
  });
});
