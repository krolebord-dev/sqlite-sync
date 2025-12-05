import { SQLiteMemoryDb } from "./sqlite-memory-db";
import { deserializeHLC, HLCCounter, serializeHLC } from "./hlc";
import { startPerformanceLogger, type Logger } from "./logger";
import { SQLiteWorkerDb } from "./sqlite-worker-db";
import { generateId } from "./utils";
import type { WorkerNotificationMessage } from "./worker-common";
import {
  applyCrdtEventMutations,
  persistCrdtEvent,
} from "./sqlite-crdt/apply-crdt-event";
import {
  applyMemoryDbSchema,
  type MemoryDbSchema,
} from "./migrations/system-schema";
import { registerCrdtFunctions } from "./sqlite-crdt/crdt-table-schema";
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

  private isTabSyncEnabled: boolean = true;

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
      syncedDb.startFlushingPendingEvents();
    });

    return syncedDb;
  }

  get tabSyncEnabled() {
    return this.isTabSyncEnabled;
  }

  set tabSyncEnabled(value: boolean) {
    this.isTabSyncEnabled = !!value;
    if (this.isTabSyncEnabled) {
      this.startFlushingPendingEvents();
    }
  }

  private async copyWorkerDbToMemoryDb() {
    const snapshot = await this.workerDb.getSnapshot();
    this.memoryDb.useSnapshot(snapshot.file);
    this.memoryDbSyncId = snapshot.syncId;
  }

  // private enqueueLocalCrdtEvent(event: LocalCrdtEvent) {
  //   this.localCrdtEventsQueue.push(event);
  //   this.startFlushingPendingEvents();
  // }

  private flushPendingEventsPromise: Promise<void> | null = null;
  private startFlushingPendingEvents() {
    if (this.flushPendingEventsPromise || !this.isTabSyncEnabled) {
      return;
    }

    this.flushPendingEventsPromise = this._flushPendingCrdtEventsToWorkerDb()
      .catch((error) => {
        console.error("error flushing pending crdt events to worker db", error);
      })
      .finally(() => {
        this.flushPendingEventsPromise = null;
      });
  }

  private async _flushPendingCrdtEventsToWorkerDb() {
    await Promise.resolve();
    while (true) {
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
    }

    // TODO: handle errors and retries. Currently events are lost if the worker db is not available which may lead to desync
  }

  private handleWorkerNotification(notification: WorkerNotificationMessage) {
    switch (notification.notificationType) {
      case "new-event-applied": {
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
          console.error(
            "sync gap detected",
            notification.event.sync_id,
            this.memoryDbSyncId,
            notification.event
          );
          return;
        }

        this.memoryDbSyncId = notification.event.sync_id;
        if (notification.event.node_id !== this.tabId) {
          this.hlcCounter.mergeHLC(
            deserializeHLC(notification.event.timestamp)
          );
          applyCrdtEventMutations({
            db: this.memoryDb.db,
            updateLogTableName: "crdt_update_log",
            event: {
              ...notification.event,
              payload: JSON.parse(notification.event.payload),
            },
          });
        }
        return;
      }
      default: {
        notification.notificationType satisfies never;
      }
    }
  }
}
