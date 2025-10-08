import { SQLocalKysely } from "sqlocal/kysely";
import { SQLiteMemoryDb } from "./sqlite-memory-db";
import type { Kysely } from "kysely";
import { createSQLiteMemoryKysely } from "./sqlite-memory-kysely-driver";
import { createDeferredPromise } from "./utils";

type SyncedDbOptions = {
  dbPath: string;
};

export class SyncedDb<Database> {
  public readonly memoryDb: SQLiteMemoryDb<Database>;
  public readonly workerDb: SQLocalKysely;
  public readonly kysely: Kysely<Database>;

  constructor(
    memoryDb: SQLiteMemoryDb<Database>,
    workerDb: SQLocalKysely,
    kysely: Kysely<Database>
  ) {
    this.memoryDb = memoryDb;
    this.workerDb = workerDb;
    this.kysely = kysely;
  }

  public static async create<Database>(options: SyncedDbOptions) {
    const [memoryDb, workerDb] = await Promise.all([
      SQLiteMemoryDb.create({
        logger: (type, message) => {
          console.log(`[${type}] ${message}`);
        },
      }),
      createWorkerDb(options.dbPath),
    ]);

    const kysely = createSQLiteMemoryKysely<Database>(memoryDb);

    return new SyncedDb<Database>(memoryDb, workerDb, kysely);
  }
}

async function createWorkerDb(dbPath: string) {
  const workerDbReadyPromise = createDeferredPromise<boolean>();
  const workerDb = new SQLocalKysely({
    databasePath: dbPath,
    onConnect: () => workerDbReadyPromise.resolve(true),
  });

  await workerDbReadyPromise.promise;

  return workerDb;
}
