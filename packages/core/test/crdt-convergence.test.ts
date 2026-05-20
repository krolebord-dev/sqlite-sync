import { describe, expect, it } from "vitest";
import { HLCCounter } from "../src/hlc";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema } from "../src/migrations/system-schema";
import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../src/sqlite-crdt/crdt-table-schema";
import { makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";

const BASE_TABLE = "todo";
const CRDT_TABLE = "_todo";

type TodoRow = {
  id: string;
  title: string;
  completed: boolean;
  tombstone: boolean | number;
};

type RawTodoRow = {
  id: string;
  title: string;
  completed: number | boolean;
  tombstone: number | boolean;
};

type RemoteEvent = Pick<
  PersistedCrdtEvent,
  "type" | "dataset" | "item_id" | "payload" | "timestamp" | "schema_version"
>;

const noopLogger = () => {};

async function createReplica(
  nodeId: string,
  initialTime: number,
  opts: { preloadedEvents?: PersistedCrdtEvent[] } = {},
) {
  const reactiveDb = await createSQLiteReactiveDb<{
    [BASE_TABLE]: RawTodoRow;
    [CRDT_TABLE]: RawTodoRow;
    persisted_crdt_events: PersistedCrdtEvent;
    crdt_update_log: CrdtUpdateLogItem;
  }>({
    snapshot: new Uint8Array(),
    logger: noopLogger,
  });
  const db = reactiveDb.db;

  db.execute(`
    CREATE TABLE "${BASE_TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "completed" INTEGER NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  applyMemoryDbSchema(db);
  makeCrdtTable({
    db,
    baseTableName: BASE_TABLE,
    crdtTableName: CRDT_TABLE,
  });

  for (const event of opts.preloadedEvents ?? []) {
    db.execute({
      sql: `
        INSERT INTO "persisted_crdt_events" (
          "sync_id",
          "schema_version",
          "status",
          "type",
          "timestamp",
          "origin",
          "source_node_id",
          "dataset",
          "item_id",
          "payload"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      parameters: [
        event.sync_id,
        event.schema_version,
        event.status,
        event.type,
        event.timestamp,
        event.origin,
        event.source_node_id,
        event.dataset,
        event.item_id,
        event.payload,
      ],
    });
  }

  let currentTime = initialTime;
  const schemaVersion = { current: 0 };
  const migrator = createMigrator({
    migrations: createMigrations(() => ({ 0: [] })),
    schemaVersion,
  });

  const { crdtStorage: storage } = await createMemoryDb({
    nodeId,
    migrator,
    reactiveDb,
    hlcCounter: new HLCCounter(nodeId, () => currentTime),
    crdtTables: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
    initializeSchema: false,
  });

  const waitForProcessing = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [{ pendingCount }] = db.execute<{ pendingCount: number }>(
        `SELECT count(*) AS pendingCount FROM "persisted_crdt_events" WHERE "status" = 'pending'`,
      ).rows;
      if (pendingCount === 0) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`Replica ${nodeId} still has pending events after waiting`);
  };

  await waitForProcessing();

  return {
    nodeId,
    storage,
    db,
    setTime(value: number) {
      currentTime = value;
    },
    async createTodo(todo: TodoRow) {
      db.execute({
        sql: `
          INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
          VALUES (?, ?, ?, ?)
        `,
        parameters: [todo.id, todo.title, Number(todo.completed), Number(Boolean(todo.tombstone))],
      });
      await waitForProcessing();
    },
    async updateTodo(todoId: string, payload: Partial<TodoRow>) {
      const entries = Object.entries(payload);
      if (entries.length === 0) {
        return;
      }

      db.execute({
        sql: `UPDATE "${CRDT_TABLE}" SET ${entries.map(([key]) => `"${key}" = ?`).join(", ")} WHERE "id" = ?`,
        parameters: [
          ...entries.map(([key, value]) =>
            key === "completed" || key === "tombstone" ? Number(Boolean(value)) : value,
          ),
          todoId,
        ],
      });
      await waitForProcessing();
    },
    async importEvents(events: RemoteEvent[]) {
      storage.enqueueRemoteEvents(events);
      await waitForProcessing();
    },
    exportEvents(afterSyncId: number) {
      const events = db.execute<PersistedCrdtEvent>({
        sql: `
          SELECT *
          FROM "persisted_crdt_events"
          WHERE "sync_id" > ?
            AND "status" = 'applied'
            AND "origin" != 'remote'
          ORDER BY "sync_id" ASC
          LIMIT 100
        `,
        parameters: [afterSyncId],
      }).rows;

      return {
        nextSyncId: events[events.length - 1]?.sync_id ?? afterSyncId,
        events: events.map<RemoteEvent>(({ type, dataset, item_id, payload, timestamp, schema_version }) => ({
          type,
          dataset,
          item_id,
          payload,
          timestamp,
          schema_version,
        })),
      };
    },
    getTodo(todoId: string): TodoRow | null {
      const row = db.execute<RawTodoRow>({
        sql: `SELECT * FROM "${BASE_TABLE}" WHERE "id" = ?`,
        parameters: [todoId],
      }).rows[0];
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        title: row.title,
        completed: Boolean(row.completed),
        tombstone: Number(row.tombstone) === 0 ? false : Number(row.tombstone),
      };
    },
    getPersistedEvent(syncId: number) {
      return db.execute<PersistedCrdtEvent>({
        sql: `SELECT * FROM "persisted_crdt_events" WHERE "sync_id" = ?`,
        parameters: [syncId],
      }).rows[0];
    },
  };
}

async function syncOneWay(
  from: Awaited<ReturnType<typeof createReplica>>,
  to: Awaited<ReturnType<typeof createReplica>>,
  afterSyncId: number,
) {
  const { events, nextSyncId } = from.exportEvents(afterSyncId);
  if (events.length > 0) {
    await to.importEvents(events);
  }
  return nextSyncId;
}

describe("CRDT convergence for parallel entity edits", () => {
  it("replays pending persisted events on startup", async () => {
    const replica = await createReplica("node-a", 1_000, {
      preloadedEvents: [
        {
          sync_id: 1,
          schema_version: 0,
          status: "pending",
          type: "item-created",
          timestamp: "000000000001000:00000:remote-node",
          origin: "remote",
          source_node_id: "",
          dataset: BASE_TABLE,
          item_id: "todo-1",
          payload: JSON.stringify({
            id: "todo-1",
            title: "Recovered after restart",
            completed: false,
            tombstone: false,
          }),
        },
      ],
    });

    expect(replica.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Recovered after restart",
      completed: false,
      tombstone: false,
    });
    expect(replica.getPersistedEvent(1)?.status).toBe("applied");
  });

  it("merges concurrent updates to different fields", async () => {
    const replicaA = await createReplica("node-a", 1_000);
    const replicaB = await createReplica("node-b", 1_000);

    await replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(2_000);

    await replicaA.updateTodo("todo-1", { title: "Updated by A" });
    await replicaB.updateTodo("todo-1", { completed: true });

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
    const replicaA = await createReplica("node-a", 1_000);
    const replicaB = await createReplica("node-b", 1_000);

    await replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(3_000);

    await replicaA.updateTodo("todo-1", { title: "Older title" });
    await replicaB.updateTodo("todo-1", { title: "Newer title" });

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
    const replicaA = await createReplica("node-a", 1_000);
    const replicaB = await createReplica("node-b", 1_000);

    await replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    let syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    replicaB.setTime(3_000);

    await replicaA.updateTodo("todo-1", { title: "Edited before delete" });
    await replicaB.updateTodo("todo-1", { tombstone: 1 });

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
