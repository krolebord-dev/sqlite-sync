import { describe, expect, it } from "vitest";
import { HLCCounter } from "../src/hlc";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { createCrdtApplyFunction } from "../src/sqlite-crdt/apply-crdt-event";
import { createCrdtStorage } from "../src/sqlite-crdt/crdt-storage";
import type { CrdtUpdateLogPayload, PersistedCrdtEvent } from "../src/sqlite-crdt/crdt-table-schema";

const DATASET = "_todo";

type TodoRow = {
  id: string;
  title: string;
  completed: boolean;
  tombstone: boolean | number;
};

type RemoteEvent = Pick<
  PersistedCrdtEvent,
  "type" | "dataset" | "item_id" | "payload" | "timestamp" | "schema_version"
>;

function createReplica(nodeId: string, initialTime: number) {
  const rows = new Map<string, Record<string, unknown>>();
  const updateLogs = new Map<string, CrdtUpdateLogPayload>();
  const persistedEvents: PersistedCrdtEvent[] = [];
  const schemaVersion = { current: 0 };
  const syncId = { current: 0 };
  let currentTime = initialTime;

  const migrator = createMigrator({
    migrations: createMigrations(() => ({ 0: [] })),
    schemaVersion,
  });

  const applyCrdtEvent = createCrdtApplyFunction({
    getCrdtUpdateLog: ({ dataset, itemId }) => {
      const meta = updateLogs.get(`${dataset}:${itemId}`);
      return meta ? { ...meta } : null;
    },
    insertItem: ({ payload }) => {
      rows.set(String(payload.id), { ...payload });
    },
    insertCrdtUpdateLog: ({ dataset, itemId, payload }) => {
      updateLogs.set(`${dataset}:${itemId}`, JSON.parse(payload) as CrdtUpdateLogPayload);
    },
    updateItem: ({ itemId, payload }) => {
      const currentRow = rows.get(itemId);
      if (!currentRow) {
        throw new Error(`Item ${itemId} not found`);
      }
      rows.set(itemId, { ...currentRow, ...payload });
    },
    updateCrdtUpdateLog: ({ dataset, itemId, payload }) => {
      updateLogs.set(`${dataset}:${itemId}`, JSON.parse(payload) as CrdtUpdateLogPayload);
    },
  });

  const storage = createCrdtStorage({
    nodeId,
    syncId,
    migrator,
    hlc: new HLCCounter(nodeId, () => currentTime),
    persistEvent: (event) => {
      persistedEvents.push(event);
    },
    getEventsBatch: ({ afterSyncId, status, excludeOrigin, excludeNodeId, limit }) =>
      persistedEvents
        .filter((event) => (afterSyncId === undefined ? true : event.sync_id > afterSyncId))
        .filter((event) => (status === undefined ? true : event.status === status))
        .filter((event) => (excludeOrigin === undefined ? true : event.origin !== excludeOrigin))
        .filter((event) => (excludeNodeId === undefined ? true : event.source_node_id !== excludeNodeId))
        .sort((left, right) => left.sync_id - right.sync_id)
        .slice(0, limit ?? Number.POSITIVE_INFINITY),
    updateEvent: (eventSyncId, update) => {
      const event = persistedEvents.find((item) => item.sync_id === eventSyncId);
      if (!event) {
        throw new Error(`Event ${eventSyncId} not found`);
      }
      Object.assign(event, update);
    },
    handleCrdtEventApply: applyCrdtEvent,
  });

  return {
    storage,
    setTime(value: number) {
      currentTime = value;
    },
    createTodo(todo: TodoRow) {
      storage.applyOwnEvent({
        type: "item-created",
        dataset: DATASET,
        item_id: todo.id,
        payload: JSON.stringify(todo),
      });
    },
    updateTodo(todoId: string, payload: Partial<TodoRow>) {
      storage.applyOwnEvent({
        type: "item-updated",
        dataset: DATASET,
        item_id: todoId,
        payload: JSON.stringify(payload),
      });
    },
    async importEvents(events: RemoteEvent[]) {
      storage.enqueueRemoteEvents(events);
      await this.waitForProcessing();
    },
    exportEvents(afterSyncId: number) {
      return storage
        .getEventsBatch({
          afterSyncId,
          status: "applied",
          excludeOrigin: "remote",
          limit: 100,
        })
        .events.map<RemoteEvent>(({ type, dataset, item_id, payload, timestamp, schema_version }) => ({
          type,
          dataset,
          item_id,
          payload,
          timestamp,
          schema_version,
        }));
    },
    getTodo(todoId: string): TodoRow | null {
      const row = rows.get(todoId);
      return row ? ({ ...row } as TodoRow) : null;
    },
    async waitForProcessing() {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (persistedEvents.every((event) => event.status !== "pending")) {
          return;
        }
        await Promise.resolve();
      }
      throw new Error(`Replica ${nodeId} still has pending events after waiting`);
    },
  };
}

async function syncOneWay(
  from: ReturnType<typeof createReplica>,
  to: ReturnType<typeof createReplica>,
  afterSyncId: number,
) {
  const events = from.exportEvents(afterSyncId);
  if (events.length > 0) {
    await to.importEvents(events);
  }
  return afterSyncId + events.length;
}

describe("CRDT convergence for parallel entity edits", () => {
  it("merges concurrent updates to different fields", async () => {
    const replicaA = createReplica("node-a", 1_000);
    const replicaB = createReplica("node-b", 1_000);

    replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(2_000);

    replicaA.updateTodo("todo-1", { title: "Updated by A" });
    replicaB.updateTodo("todo-1", { completed: true });

    syncedFromA = await syncOneWay(replicaA, replicaB, syncedFromA);
    await syncOneWay(replicaB, replicaA, 0);

    const expectedTodo = {
      id: "todo-1",
      title: "Updated by A",
      completed: true,
      tombstone: false,
    };

    expect(replicaA.getTodo("todo-1")).toEqual(expectedTodo);
    expect(replicaB.getTodo("todo-1")).toEqual(expectedTodo);
  });

  it("uses HLC last-write-wins when two replicas edit the same field", async () => {
    const replicaA = createReplica("node-a", 1_000);
    const replicaB = createReplica("node-b", 1_000);

    replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(3_000);

    replicaA.updateTodo("todo-1", { title: "Older title" });
    replicaB.updateTodo("todo-1", { title: "Newer title" });

    syncedFromA = await syncOneWay(replicaA, replicaB, syncedFromA);
    await syncOneWay(replicaB, replicaA, 0);

    expect(replicaA.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Newer title",
      completed: false,
      tombstone: false,
    });
    expect(replicaB.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Newer title",
      completed: false,
      tombstone: false,
    });
  });

  it("converges when an update races with a tombstone delete", async () => {
    const replicaA = createReplica("node-a", 1_000);
    const replicaB = createReplica("node-b", 1_000);

    replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(3_000);

    replicaA.updateTodo("todo-1", { title: "Edited before delete" });
    replicaB.updateTodo("todo-1", { tombstone: 1 });

    syncedFromA = await syncOneWay(replicaA, replicaB, syncedFromA);
    await syncOneWay(replicaB, replicaA, 0);

    expect(replicaA.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Edited before delete",
      completed: false,
      tombstone: 1,
    });
    expect(replicaB.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Edited before delete",
      completed: false,
      tombstone: 1,
    });
  });
});
