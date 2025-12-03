import { SQLiteMemoryDb } from "./sqlite-memory-db";
import { HLCCounter, serializeHLC } from "./hlc";
import { introspectDb, type TableMetadata } from "./introspection";
import { startPerformanceLogger, type Logger } from "./logger";
import { SQLiteWorkerDb } from "./sqlite-worker-db";
import { generateId } from "./utils";
import {
  memoryDbMigration,
  type MemoryDbSchema,
} from "./migrations/system-schema";
import type { SQLiteDbWrapper } from "./sqlite-db-wrapper";
import type { WorkerNotificationMessage } from "./worker-common";
import { applyCrdtEvent } from "./apply-crdt-event";

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

  private tablesSchema: Record<string, TableMetadata> = {};
  private shouldTriggerCrdtEvents: 0 | 1 = 1;

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

    const syncedDb = new SyncedDb<Database>(
      tabId,
      clientId,
      hlcCounter,
      memoryDb,
      workerDb,
      logger
    );

    await syncedDb.initialize();

    return syncedDb;
  }

  private async initialize() {
    await this.copyWorkerDbToMemoryDb();

    this.tablesSchema = introspectDb(this.memoryDb);

    this.registerSystemFunctions();

    this.memoryDb.db.executeTransaction(() => {
      memoryDbMigration.up(this.memoryDb.db);
    });

    this.memoryDb.subscribeToTableChanges("pending_crdt_events", () => {
      this.flushPendingCrdtEventsToWorkerDb();
    });
  }

  private registerSystemFunctions() {
    this.memoryDb.createScalarFunction({
      name: "gen_id",
      callback: generateId,
      deterministic: false,
      directOnly: false,
      innocuous: true,
    });

    const hlcNext = () => serializeHLC(this.hlcCounter.getNextHLC());
    this.memoryDb.createScalarFunction({
      name: "hlc_next",
      callback: hlcNext,
      deterministic: false,
      directOnly: false,
      innocuous: false,
    });

    this.memoryDb.createScalarFunction({
      name: "should_trigger_crdt_events",
      callback: () => this.shouldTriggerCrdtEvents,
      deterministic: false,
      directOnly: false,
      innocuous: true,
    });
  }

  private async copyWorkerDbToMemoryDb() {
    const snapshot = await this.workerDb.getSnapshot();
    this.memoryDb.useSnapshot(snapshot.file);
    this.memoryDbSyncId = snapshot.syncId;
  }

  crdtifyTable(table: string) {
    const tableSchema = this.tablesSchema[table];

    if (!tableSchema) {
      throw new Error(`Table ${table} not found in schema`);
    }

    const allColumnNames = tableSchema.columns.map((column) => column.name);
    const valueColumnNames = allColumnNames.filter((column) => column !== "id");

    this.memoryDb.db.execute(`
create trigger ${table}_created
after insert on ${table}
for each row
when should_trigger_crdt_events() = 1
begin
  insert into pending_crdt_events (id, timestamp, type, dataset, item_id, payload)
  values (
    gen_id(),
    hlc_next(),
    'item-created',
    '${table}',
    new.id,
    json_object(${allColumnNames
      .map((column) => `'${column}', new.${column}`)
      .join(",")})
  );
end;
`);

    this.memoryDb.db.execute(`
create trigger ${table}_updated
after update on ${table}
for each row
when should_trigger_crdt_events() = 1 and (${valueColumnNames
      .map((column) => `old.${column} is not new.${column}`)
      .join(" or ")})
begin
  insert into pending_crdt_events (id, timestamp, type, dataset, item_id, payload)
  values (
    gen_id(),
    hlc_next(),
    'item-updated',
    '${table}',
    new.id,
    '{' || substr(${valueColumnNames
      .map(
        (col) => `
      (CASE WHEN OLD.${col} IS NOT NEW.${col} 
      THEN ',"${col}":' || json_quote(NEW.${col}) ELSE '' END)
      `
      )
      .join(" || ")}, 2) || '}'
  );
end;
`);

    this.memoryDb.db.execute(`
create trigger ${table}_deleted
before delete on ${table}
for each row
when should_trigger_crdt_events() = 1
begin
  update ${table}
  set tombstone = 1
  where id = old.id;
  select raise(IGNORE);
end;
`);

    this.memoryDb.db.execute(`
create view ${table}_v as
select * from ${table}
where tombstone = 0;`);
  }

  async flushPendingCrdtEventsToWorkerDb() {
    const perf = startPerformanceLogger(this.logger);
    const pendingCrdtEvents = (
      this.memoryDb.db as SQLiteDbWrapper<MemoryDbSchema>
    ).executePrepared("pop-pending-crdt-events", {}, (db) =>
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

    // TODO error logging
  }

  private handleWorkerNotification(notification: WorkerNotificationMessage) {
    switch (notification.notificationType) {
      case "new-event-applied": {
        if (notification.event.sync_id <= this.memoryDbSyncId) {
          return;
        }
        if (notification.event.sync_id - this.memoryDbSyncId > 1) {
          console.error(
            "sync gap detected",
            notification.event.sync_id,
            this.memoryDbSyncId
          );
          return;
        }
        this.memoryDbSyncId = notification.event.sync_id;
        if (notification.event.node_id !== this.tabId) {
          try {
            this.shouldTriggerCrdtEvents = 0;
            applyCrdtEvent(this.memoryDb.db, notification.event);
          } finally {
            this.shouldTriggerCrdtEvents = 1;
          }
        }
        return;
      }
      default: {
        notification.notificationType satisfies never;
      }
    }
  }
}
