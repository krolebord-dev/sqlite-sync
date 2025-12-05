import { SQLiteMemoryDb } from "./sqlite-memory-db";
import { deserializeHLC, HLCCounter, serializeHLC } from "./hlc";
import { startPerformanceLogger, type Logger } from "./logger";
import { SQLiteWorkerDb } from "./sqlite-worker-db";
import { ensureSingletonExecution, generateId } from "./utils";
import type { WorkerNotificationMessage } from "./worker-common";
import {
  applyCrdtEventMutations,
  persistCrdtEvent,
} from "./sqlite-crdt/apply-crdt-event";
import {
  applyMemoryDbSchema,
  type MemoryDbSchema,
} from "./migrations/system-schema";
import {
  registerCrdtFunctions,
  type AppliedCrdtEvent,
} from "./sqlite-crdt/crdt-table-schema";
import type { SQLiteDbWrapper } from "./sqlite-db-wrapper";

type SyncedDbOptions = {
  dbPath: string;
  tabId?: string;
  clientId: string;
  logger?: Logger;
};

export class SyncedDb<Database> {
  public readonly tabId: string;
  public readonly clientId: string;

  public readonly hlcCounter: HLCCounter;
  public readonly memoryDb: SQLiteMemoryDb<Database>;
  public readonly workerDb: SQLiteWorkerDb;
  public readonly logger: Logger;
  public memoryDbSyncId: number;

  private isLocalSyncEnabled: boolean = true;

  private constructor(
    tabId: string,
    clientId: string,
    hlcCounter: HLCCounter,
    memoryDb: SQLiteMemoryDb<Database>,
    workerDb: SQLiteWorkerDb,
    logger: Logger
  ) {
    this.hlcCounter = hlcCounter;
    this.memoryDb = memoryDb;
    this.workerDb = workerDb;
    this.logger = logger;
    this.tabId = tabId;
    this.clientId = clientId;
    this.memoryDbSyncId = 0;
  }

  public static async create<Database>(options: SyncedDbOptions) {
    const logger = options.logger ?? (() => {});

    const clientId = `c-${options.clientId}`;
    const tabId = `${clientId}:t-${options.tabId ?? generateId()}`;

    const hlcCounter = new HLCCounter(tabId, () => Date.now());

    const [memoryDb, workerDb] = await Promise.all([
      SQLiteMemoryDb.create<Database>({ logger }),
      SQLiteWorkerDb.create({
        tabId,
        clientId,
        dbPath: options.dbPath,
        logger,
        onNotification: (notification) => {
          syncedDb.handleWorkerNotification(notification);
        },
      }),
    ]);

    (window as any).memDb = memoryDb;

    const syncedDb = new SyncedDb<Database>(
      tabId,
      clientId,
      hlcCounter,
      memoryDb,
      workerDb,
      logger
    );

    await syncedDb.copyWorkerDbToMemoryDb();
    applyMemoryDbSchema(syncedDb.memoryDb.db);
    registerCrdtFunctions({
      db: syncedDb.memoryDb.db,
      getTableSchema: (dataset: string) => {
        return syncedDb.memoryDb.db.dbSchema[dataset];
      },
      getNextTimestamp: () => serializeHLC(syncedDb.hlcCounter.getNextHLC()),
      updateLogTableName: "crdt_update_log",
      onEventApplied: (event) => {
        persistCrdtEvent(syncedDb.memoryDb.db, "pending_crdt_events", {
          ...event,
          id: generateId(),
          node_id: syncedDb.tabId,
          payload: JSON.stringify(event.payload),
        });
      },
    });

    syncedDb.memoryDb.subscribeToTableChanges("pending_crdt_events", () => {
      if (syncedDb.isLocalSyncEnabled) {
        syncedDb.startFlushingPendingEvents();
      }
    });

    return syncedDb;
  }

  get tabSyncEnabled() {
    return this.isLocalSyncEnabled;
  }

  set tabSyncEnabled(value: boolean) {
    this.isLocalSyncEnabled = !!value;
    if (this.isLocalSyncEnabled) {
      this.startFlushingPendingEvents();
      this.pullEventsFromWorkerDb();
    }
  }

  private async copyWorkerDbToMemoryDb() {
    const snapshot = await this.workerDb.getSnapshot();
    this.memoryDb.useSnapshot(snapshot.file);
    this.memoryDbSyncId = snapshot.syncId;
  }

  private readonly startFlushingPendingEvents = ensureSingletonExecution(
    this.flushPendingCrdtEvents.bind(this)
  );

  private async flushPendingCrdtEvents() {
    await Promise.resolve();

    const perf = startPerformanceLogger(this.logger);
    const pendingCrdtEvents = (
      this.memoryDb.db as unknown as SQLiteDbWrapper<MemoryDbSchema>
    ).executePrepared("flush-pending-crdt-events", {}, (db) =>
      db.deleteFrom("pending_crdt_events").returningAll()
    );

    if (pendingCrdtEvents.length === 0) {
      return;
    }

    await this.workerDb.pushLocalEvents(this.tabId, pendingCrdtEvents);

    perf.logEnd(
      "flushPendingCrdtEvents",
      `flushed ${pendingCrdtEvents.length} events`,
      "info"
    );

    // TODO: handle errors and retries. Currently events are lost if the worker db is not available which may lead to desync
  }

  private readonly pullEventsFromWorkerDb = ensureSingletonExecution(
    async () => {
      if (!this.isLocalSyncEnabled) {
        return;
      }

      const events = await this.workerDb.pullEvents({
        startFromSyncId: this.memoryDbSyncId,
        excludeNodeId: this.tabId,
      });

      for (const event of events.events) {
        this.applyRemoteEvent(event);
      }

      this.memoryDbSyncId = events.newSyncId;
    }
  );

  private handleWorkerNotification(notification: WorkerNotificationMessage) {
    switch (notification.notificationType) {
      case "new-event-applied": {
        if (!this.isLocalSyncEnabled) {
          return;
        }

        if (notification.event.sync_id <= this.memoryDbSyncId) {
          console.error(
            "sync id is not greater than memory db sync id",
            notification.event.sync_id,
            this.memoryDbSyncId,
            notification.event
          );
          return;
        }

        if (notification.event.sync_id - this.memoryDbSyncId > 1) {
          this.pullEventsFromWorkerDb();
          return;
        }

        this.memoryDbSyncId = notification.event.sync_id;
        if (notification.event.node_id !== this.tabId) {
          this.applyRemoteEvent(notification.event);
        }
        return;
      }
      default: {
        notification.notificationType satisfies never;
      }
    }
  }

  private applyRemoteEvent(event: AppliedCrdtEvent) {
    this.hlcCounter.mergeHLC(deserializeHLC(event.timestamp));
    applyCrdtEventMutations({
      db: this.memoryDb.db,
      updateLogTableName: "crdt_update_log",
      event: {
        ...event,
        payload: JSON.parse(event.payload),
      },
    });
  }
}
