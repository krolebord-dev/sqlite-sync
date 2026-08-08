import { describe, expect, it } from "vitest";
import { HLCCounter, serializeHLC } from "../src/hlc";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema } from "../src/migrations/system-schema";
import { t } from "../src/schema/table-builder";
import { CrdtEventValidationError } from "../src/schema/validate-crdt-event";
import {
  CRDT_EVENT_NO_OP_PAYLOAD,
  type CrdtUpdateLogItem,
  type PersistedCrdtEvent,
} from "../src/sqlite-crdt/crdt-table-schema";
import { CRDT_CHANGE_INTENTS_TABLE, makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";
import { createStoredValue } from "../src/sqlite-crdt/stored-value";

const BASE_TABLE = "todo";
const CRDT_TABLE = "_todo";

const todoSyncSchema = {
  tablesConfig: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
  tables: {
    [CRDT_TABLE]: t.table({
      title: t.text(),
      completed: t.boolean(),
    }),
  },
};

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
  opts: {
    preloadedEvents?: PersistedCrdtEvent[];
    trackEventHlcAccumulator?: boolean;
    migrator?: ReturnType<typeof createMigrator>;
    schemaVersion?: { current: number };
  } = {},
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
  const schemaVersion = opts.schemaVersion ?? { current: 0 };
  const migrator =
    opts.migrator ??
    createMigrator({
      migrations: createMigrations(() => ({ 0: [] })),
      schemaVersion,
    });

  const { crdtStorage: storage } = await createMemoryDb({
    nodeId,
    migrator,
    reactiveDb,
    hlcCounter: new HLCCounter(nodeId, () => currentTime),
    crdtTables: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
    syncDbSchema: todoSyncSchema,
    initializeSchema: false,
    eventHlcAccumulator: opts.trackEventHlcAccumulator
      ? createStoredValue({
          initialValue: "",
        })
      : undefined,
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
    waitForProcessing,
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
    async deleteTodo(todoId: string) {
      db.execute({
        sql: `DELETE FROM "${CRDT_TABLE}" WHERE "id" = ?`,
        parameters: [todoId],
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
    getPersistedEvents() {
      return db.execute<PersistedCrdtEvent>(`SELECT * FROM "persisted_crdt_events" ORDER BY "sync_id" ASC`).rows;
    },
    getEventHlcAccumulator() {
      return storage.getEventHlcAccumulator();
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

  it("marks migration-dropped events as applied with no-op payload", async () => {
    const schemaVersion = { current: 1 };
    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [steps.dropTable(BASE_TABLE)],
      })),
      schemaVersion,
    });
    const eventTimestamp = serializeHLC(new HLCCounter("origin-node", () => 1_000).getCurrentHLC());

    const replicaA = await createReplica("node-a", 1_000, {
      migrator,
      schemaVersion,
      trackEventHlcAccumulator: true,
      preloadedEvents: [
        {
          sync_id: 1,
          schema_version: 0,
          status: "pending",
          type: "item-created",
          timestamp: eventTimestamp,
          origin: "own",
          source_node_id: "node-a",
          dataset: BASE_TABLE,
          item_id: "todo-1",
          payload: JSON.stringify({
            id: "todo-1",
            title: "Dropped by migration",
            completed: false,
          }),
        },
      ],
    });
    const replicaB = await createReplica("node-b", 1_000, {
      migrator,
      schemaVersion,
      trackEventHlcAccumulator: true,
    });

    const droppedEvent = replicaA.getPersistedEvent(1);
    expect(droppedEvent?.status).toBe("applied");
    expect(droppedEvent?.payload).toBe(CRDT_EVENT_NO_OP_PAYLOAD);
    expect(replicaA.getTodo("todo-1")).toBeNull();

    const { events } = replicaA.exportEvents(0);
    await replicaB.importEvents(events);

    const importedEvent = replicaB.getPersistedEvent(1);
    expect(importedEvent?.status).toBe("applied");
    expect(importedEvent?.payload).toBe(CRDT_EVENT_NO_OP_PAYLOAD);
    expect(replicaB.getTodo("todo-1")).toBeNull();
    expect(replicaB.getEventHlcAccumulator()).toBe(replicaA.getEventHlcAccumulator());
  });

  it("recomputes the event HLC accumulator from applied history when it was never computed", async () => {
    const timestamps = [1_000, 1_001, 1_002].map((time) =>
      serializeHLC(new HLCCounter("origin-node", () => time).getCurrentHLC()),
    );

    const makeEvents = (status: PersistedCrdtEvent["status"]): PersistedCrdtEvent[] =>
      timestamps.map((timestamp, index) => ({
        sync_id: index + 1,
        schema_version: 0,
        status,
        type: "item-created",
        timestamp,
        origin: "remote",
        source_node_id: "origin-node",
        dataset: BASE_TABLE,
        item_id: `todo-${index + 1}`,
        payload: JSON.stringify({ id: `todo-${index + 1}`, title: `Todo ${index + 1}`, completed: false }),
      }));

    // Applies the events through the normal path, so the accumulator is built
    // up event-by-event as each one is applied.
    const incremental = await createReplica("node-a", 1_000, {
      trackEventHlcAccumulator: true,
      preloadedEvents: makeEvents("pending"),
    });

    // Same events, but already marked applied with the accumulator never
    // computed ("" sentinel) — mirrors a DB created before the accumulator
    // existed. On construction it must be rebuilt from the applied history.
    const recomputed = await createReplica("node-b", 1_000, {
      trackEventHlcAccumulator: true,
      preloadedEvents: makeEvents("applied"),
    });

    expect(recomputed.getEventHlcAccumulator()).not.toBe("");
    expect(recomputed.getEventHlcAccumulator()).toBe(incremental.getEventHlcAccumulator());
  });

  it("marks duplicate event deliveries as deduped", async () => {
    const replicaA = await createReplica("node-a", 1_000);
    const replicaB = await createReplica("node-b", 1_000, { trackEventHlcAccumulator: true });

    await replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    const { events } = replicaA.exportEvents(0);
    await replicaB.importEvents(events);
    const accumulatorAfterFirstImport = replicaB.getEventHlcAccumulator();

    await replicaB.importEvents(events);
    const persistedEvents = replicaB.getPersistedEvents();
    const acceptedEvents = persistedEvents.slice(0, events.length);
    const duplicateEvents = persistedEvents.slice(events.length);

    expect(acceptedEvents.map((event) => event.status)).toEqual(events.map(() => "applied"));
    expect(duplicateEvents.map((event) => event.status)).toEqual(events.map(() => "deduped"));
    expect(duplicateEvents.map((event) => event.timestamp)).toEqual(acceptedEvents.map((event) => event.timestamp));
    expect(replicaB.getEventHlcAccumulator()).toBe(accumulatorAfterFirstImport);
    expect(replicaB.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });
  });

  it("does not expose applied events after an earlier pending gap", async () => {
    const replica = await createReplica("node-a", 1_000);
    const remoteTimestamp = serializeHLC(new HLCCounter("remote-node", () => 2_000).getCurrentHLC());

    const dispatchedSyncIds: number[] = [];
    replica.storage.addEventListener("events-applied", (event) => {
      dispatchedSyncIds.push(event.payload.syncId);
    });

    const remoteProcessing = replica.storage.enqueueRemoteEvents([
      {
        schema_version: 0,
        timestamp: remoteTimestamp,
        type: "item-created",
        dataset: BASE_TABLE,
        item_id: "remote-todo",
        payload: JSON.stringify({
          id: "remote-todo",
          title: "Remote todo",
          completed: false,
          tombstone: false,
        }),
      },
    ]).processed;

    replica.db.execute({
      sql: `
        INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
        VALUES (?, ?, ?, ?)
      `,
      parameters: ["local-todo", "Local todo", 0, 0],
    });

    const beforeGapClosed = replica.storage.getEventsBatch({
      status: "applied",
      afterSyncId: 0,
      limit: 100,
      excludeOrigin: "remote",
    });

    expect(beforeGapClosed.events).toEqual([]);
    expect(beforeGapClosed.nextSyncId).toBe(0);
    expect(Math.max(0, ...dispatchedSyncIds)).toBe(0);

    await remoteProcessing;

    const afterGapClosed = replica.storage.getEventsBatch({
      status: "applied",
      afterSyncId: 0,
      limit: 100,
      excludeOrigin: "remote",
    });

    expect(afterGapClosed.events.map((event) => event.item_id)).toEqual(["local-todo"]);
    expect(afterGapClosed.nextSyncId).toBe(2);
    expect(Math.max(...dispatchedSyncIds)).toBe(2);
  });

  it("materializes own writes eagerly but defers bookkeeping to commit", async () => {
    const replica = await createReplica("node-a", 1_000, { trackEventHlcAccumulator: true });

    const dispatchedSyncIds: number[] = [];
    replica.storage.addEventListener("events-applied", (event) => {
      dispatchedSyncIds.push(event.payload.syncId);
    });

    const initialAccumulator = replica.getEventHlcAccumulator();

    replica.db.execute({
      sql: `
        INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
        VALUES (?, ?, ?, ?)
      `,
      parameters: ["own-todo", "Own todo", 0, 0],
    });

    // Synchronous window: the row is materialized inside the writing transaction,
    // but the event is still pending and no bookkeeping (accumulator, dispatch)
    // has run — that is deferred to the post-commit pipeline.
    expect(replica.getTodo("own-todo")).toEqual({
      id: "own-todo",
      title: "Own todo",
      completed: false,
      tombstone: false,
    });
    const pendingEvent = replica.getPersistedEvent(1);
    expect(pendingEvent.origin).toBe("own-applied");
    expect(pendingEvent.status).toBe("pending");
    expect(replica.getEventHlcAccumulator()).toBe(initialAccumulator);
    expect(dispatchedSyncIds).toEqual([]);

    await replica.waitForProcessing();

    // After the pipeline runs the event is finalized and folded into the accumulator.
    expect(replica.getPersistedEvent(1).status).toBe("applied");
    expect(replica.getEventHlcAccumulator()).not.toBe(initialAccumulator);
    expect(dispatchedSyncIds).toEqual([1]);
  });

  it("drains ordered row intents before the next statement in a transaction", async () => {
    const replica = await createReplica("node-a", 1_000);

    replica.db.executeTransaction((tx) => {
      tx.execute({
        sql: `
          INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
          VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `,
        parameters: ["todo-1", "First", 0, 0, "todo-2", "Second", 0, 0],
      });

      const rows = tx.execute<RawTodoRow>({
        sql: `SELECT * FROM "${BASE_TABLE}" ORDER BY "id"`,
        parameters: [],
      }).rows;
      const intents = tx.execute<{ count: number }>({
        sql: `SELECT count(*) AS count FROM "${CRDT_CHANGE_INTENTS_TABLE}"`,
        parameters: [],
      }).rows;
      const events = tx.execute<PersistedCrdtEvent>({
        sql: `SELECT * FROM "persisted_crdt_events" ORDER BY "sync_id"`,
        parameters: [],
      }).rows;

      expect(rows.map((row) => row.id)).toEqual(["todo-1", "todo-2"]);
      expect(intents[0]?.count).toBe(0);
      expect(events.map((event) => event.item_id)).toEqual(["todo-1", "todo-2"]);
      expect(events.map((event) => event.status)).toEqual(["pending", "pending"]);
    });

    await replica.waitForProcessing();
    expect(replica.getPersistedEvents().map((event) => event.status)).toEqual(["applied", "applied"]);
  });

  it("persists sparse update payloads produced by the update trigger", async () => {
    const replica = await createReplica("node-a", 1_000);

    await replica.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });
    await replica.updateTodo("todo-1", { title: `It's "updated", safely` });

    expect(replica.getPersistedEvent(2)?.payload).toBe(`{"title":"It's \\"updated\\", safely"}`);
  });

  it("skips empty update payloads produced by the update trigger", async () => {
    const replica = await createReplica("node-a", 1_000);

    await replica.createTodo({
      id: "todo-1",
      title: "Unchanged",
      completed: false,
      tombstone: false,
    });
    replica.db.execute(`UPDATE "${CRDT_TABLE}" SET "title" = "title" WHERE "id" = 'todo-1'`);
    await replica.waitForProcessing();

    expect(replica.getPersistedEvents()).toHaveLength(1);
  });

  it("rejects primary-key updates without parsing an update payload", async () => {
    const replica = await createReplica("node-a", 1_000);

    await replica.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    expect(() => replica.db.execute(`UPDATE "${CRDT_TABLE}" SET "id" = 'todo-2' WHERE "id" = 'todo-1'`)).toThrowError(
      `Cannot update the "id" column of an item`,
    );
    await replica.waitForProcessing();

    expect(replica.getTodo("todo-1")?.title).toBe("Initial title");
    expect(replica.getTodo("todo-2")).toBeNull();
    expect(replica.getPersistedEvents()).toHaveLength(1);
  });

  it("executes only the first statement in an execute call", async () => {
    const replica = await createReplica("node-a", 1_000);

    replica.db.execute(`
      INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
      VALUES ('first', 'First; valid title', 0, 0);
      INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
      VALUES ('second', 'Second', 0, 0);
    `);

    await replica.waitForProcessing();
    expect(replica.getTodo("first")?.title).toBe("First; valid title");
    expect(replica.getTodo("second")).toBeNull();
    expect(replica.getPersistedEvents().map((event) => event.item_id)).toEqual(["first"]);
  });

  it("rolls back the whole user statement when draining one of its intents fails", async () => {
    const replica = await createReplica("node-a", 1_000);
    let statementError: unknown;

    replica.db.executeTransaction((tx) => {
      try {
        tx.execute({
          sql: `
            INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)
          `,
          parameters: ["rolled-back-1", "Valid", 0, 0, "rolled-back-2", null, 0, 0],
        });
      } catch (error) {
        statementError = error;
      }

      tx.execute({
        sql: `
          INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
          VALUES (?, ?, ?, ?)
        `,
        parameters: ["committed", "Still works", 0, 0],
      });
    });

    expect(statementError).toBeInstanceOf(Error);
    await replica.waitForProcessing();

    expect(replica.getTodo("rolled-back-1")).toBeNull();
    expect(replica.getTodo("rolled-back-2")).toBeNull();
    expect(replica.getTodo("committed")?.title).toBe("Still works");
    expect(replica.getPersistedEvents().map((event) => event.item_id)).toEqual(["committed"]);
    expect(
      replica.db.execute<{ count: number }>(`SELECT count(*) AS count FROM "${CRDT_CHANGE_INTENTS_TABLE}"`).rows[0]
        ?.count,
    ).toBe(0);
  });

  it("does not leak materialization or bookkeeping when the writing transaction rolls back", async () => {
    const replicaA = await createReplica("node-a", 1_000, { trackEventHlcAccumulator: true });

    const dispatchedSyncIds: number[] = [];
    replicaA.storage.addEventListener("events-applied", (event) => {
      dispatchedSyncIds.push(event.payload.syncId);
    });

    await replicaA.createTodo({ id: "committed-1", title: "First", completed: false, tombstone: false });
    const accumulatorAfterFirst = replicaA.getEventHlcAccumulator();
    const dispatchedAfterFirst = [...dispatchedSyncIds];

    // An own write inside a transaction that aborts.
    expect(() =>
      replicaA.db.executeTransaction((tx) => {
        tx.execute({
          sql: `
            INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone")
            VALUES (?, ?, ?, ?)
          `,
          parameters: ["rolled-back", "Nope", 0, 0],
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");

    await replicaA.waitForProcessing();

    // Materialization reverted with the transaction, and nothing leaked: the
    // accumulator is unchanged, no events-applied fired, and no row persisted.
    expect(replicaA.getTodo("rolled-back")).toBeNull();
    expect(replicaA.getEventHlcAccumulator()).toBe(accumulatorAfterFirst);
    expect(dispatchedSyncIds).toEqual(dispatchedAfterFirst);
    expect(replicaA.getPersistedEvents().some((event) => event.item_id === "rolled-back")).toBe(false);

    // A later write still works (it just claims a fresh sync id, leaving a gap).
    await replicaA.createTodo({ id: "committed-2", title: "Second", completed: false, tombstone: false });

    // A replica that only ever saw the committed events ends up with the same
    // accumulator, proving the rolled-back event was never folded in.
    const replicaB = await createReplica("node-b", 5_000, { trackEventHlcAccumulator: true });
    await syncOneWay(replicaA, replicaB, 0);

    expect(replicaB.getEventHlcAccumulator()).toBe(replicaA.getEventHlcAccumulator());
    expect(replicaB.getTodo("committed-1")?.title).toBe("First");
    expect(replicaB.getTodo("committed-2")?.title).toBe("Second");
    expect(replicaB.getTodo("rolled-back")).toBeNull();
  });

  it("advances applied batch cursors over terminal filtered events", async () => {
    const replica = await createReplica("node-a", 1_000, {
      preloadedEvents: [
        {
          sync_id: 1,
          schema_version: 0,
          status: "deduped",
          type: "item-created",
          timestamp: "000000000001000:00000:remote-node",
          origin: "remote",
          source_node_id: "",
          dataset: BASE_TABLE,
          item_id: "deduped-todo",
          payload: JSON.stringify({
            id: "deduped-todo",
            title: "Deduped todo",
            completed: false,
            tombstone: false,
          }),
        },
        {
          sync_id: 2,
          schema_version: 0,
          status: "applied",
          type: "item-created",
          timestamp: "000000000001001:00000:remote-node",
          origin: "remote",
          source_node_id: "",
          dataset: BASE_TABLE,
          item_id: "remote-todo",
          payload: JSON.stringify({
            id: "remote-todo",
            title: "Remote todo",
            completed: false,
            tombstone: false,
          }),
        },
      ],
    });

    const batch = replica.storage.getEventsBatch({
      status: "applied",
      afterSyncId: 0,
      limit: 100,
      excludeOrigin: "remote",
    });

    expect(batch.events).toEqual([]);
    expect(batch.hasMore).toBe(false);
    expect(batch.nextSyncId).toBe(2);
  });

  it("applies a validated batch of own events", async () => {
    const replica = await createReplica("node-a", 1_000);

    replica.storage.applyOwnEvents([
      {
        type: "item-created",
        dataset: CRDT_TABLE,
        item_id: "todo-1",
        payload: JSON.stringify({ id: "todo-1", title: "First", completed: false }),
      },
      {
        type: "item-updated",
        dataset: CRDT_TABLE,
        item_id: "todo-1",
        payload: JSON.stringify({ completed: true }),
      },
    ]);
    await replica.waitForProcessing();

    expect(replica.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "First",
      completed: true,
      tombstone: false,
    });

    const events = replica.getPersistedEvents();
    expect(events.map((event) => [event.origin, event.status, event.dataset])).toEqual([
      ["own-applied", "applied", BASE_TABLE],
      ["own-applied", "applied", BASE_TABLE],
    ]);
  });

  it("rejects an invalid batch without mutating state or consuming sync ids", async () => {
    const replica = await createReplica("node-a", 1_000);

    expect(() =>
      replica.storage.applyOwnEvents([
        {
          type: "item-created",
          dataset: CRDT_TABLE,
          item_id: "todo-1",
          payload: JSON.stringify({ id: "todo-1", title: "First", completed: false }),
        },
        {
          type: "item-created",
          dataset: CRDT_TABLE,
          item_id: "todo-2",
          payload: JSON.stringify({ id: "todo-2", title: "Second", completed: "nope", bogus: 1 }),
        },
      ]),
    ).toThrow(CrdtEventValidationError);

    await replica.waitForProcessing();

    expect(replica.getTodo("todo-1")).toBeNull();
    expect(replica.getTodo("todo-2")).toBeNull();
    expect(replica.getPersistedEvents()).toEqual([]);

    replica.storage.applyOwnEvents([
      {
        type: "item-created",
        dataset: CRDT_TABLE,
        item_id: "todo-3",
        payload: JSON.stringify({ id: "todo-3", title: "Third", completed: false }),
      },
    ]);
    await replica.waitForProcessing();

    expect(replica.getPersistedEvent(1)?.item_id).toBe("todo-3");
  });

  it("rolls the whole batch back when materializing a later event fails", async () => {
    const replica = await createReplica("node-a", 1_000);

    expect(() =>
      replica.storage.applyOwnEvents([
        {
          type: "item-created",
          dataset: CRDT_TABLE,
          item_id: "todo-1",
          payload: JSON.stringify({ id: "todo-1", title: "First", completed: false }),
        },
        {
          type: "item-updated",
          dataset: CRDT_TABLE,
          item_id: "missing",
          payload: JSON.stringify({ completed: true }),
        },
      ]),
    ).toThrow();

    await replica.waitForProcessing();

    expect(replica.getTodo("todo-1")).toBeNull();
    expect(replica.getPersistedEvents().some((event) => event.item_id === "todo-1")).toBe(false);
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

  it("persists deletes as item-deleted events and converges across replicas", async () => {
    const replicaA = await createReplica("node-a", 1_000);
    const replicaB = await createReplica("node-b", 1_000);

    await replicaA.createTodo({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: false,
    });

    const syncedFromA = await syncOneWay(replicaA, replicaB, 0);

    replicaA.setTime(2_000);
    await replicaA.deleteTodo("todo-1");

    const deleteEvent = replicaA.getPersistedEvents().find((event) => event.type === "item-deleted");
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent?.item_id).toBe("todo-1");
    // The delete carries no field data — the tombstone is materialized on apply.
    expect(deleteEvent?.payload).toBe("{}");

    // Local view hides the deleted row, base row is tombstoned.
    expect(replicaA.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: 1,
    });

    await syncOneWay(replicaA, replicaB, syncedFromA);

    expect(replicaB.getTodo("todo-1")).toEqual({
      id: "todo-1",
      title: "Initial title",
      completed: false,
      tombstone: 1,
    });
  });
});
