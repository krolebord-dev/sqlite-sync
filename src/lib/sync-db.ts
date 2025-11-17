import { SQLocalKysely } from "sqlocal/kysely";
import { SQLiteMemoryDb } from "./sqlite-memory-db";
import { createDeferredPromise } from "./utils";

type SyncedDbOptions = {
  dbPath: string;
};

export class SyncedDb<Database> {
  public readonly memoryDb: SQLiteMemoryDb<Database>;
  public readonly workerDb: SQLocalKysely;

  constructor(memoryDb: SQLiteMemoryDb<Database>, workerDb: SQLocalKysely) {
    this.memoryDb = memoryDb;
    this.workerDb = workerDb;
  }

  public static async create<Database>(options: SyncedDbOptions) {
    const [memoryDb, workerDb] = await Promise.all([
      SQLiteMemoryDb.create<Database>({
        logger: (type, message) => {
          console.log(`[${type}] ${message}`);
        },
      }),
      createWorkerDb(options.dbPath),
    ]);

    return new SyncedDb<Database>(memoryDb, workerDb);
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
