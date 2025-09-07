import { SQLocalKysely } from "sqlocal/kysely";
import { atom, useAtom } from "jotai";
import { seedDatabase } from "./seed";
import { Kysely } from "kysely";

function createDelayedPromise<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

type SyncedDbOptions = {
  dbPath: string;
};

class SyncedDb<Database> {
  public readonly memoryDb: SQLocalKysely;
  public readonly workerDb: SQLocalKysely;
  public readonly readyPromise: Promise<void>;
  public readonly kysely: Kysely<Database>;

  private tableListeners: Map<string, Set<() => void>> = new Map();

  constructor(
    memoryDb: SQLocalKysely,
    workerDb: SQLocalKysely,
    readyPromise: Promise<void>,
    kysely: Kysely<Database>
  ) {
    this.memoryDb = memoryDb;
    this.workerDb = workerDb;
    this.readyPromise = readyPromise;
    this.kysely = kysely;
  }

  public static async create<Database>(options: SyncedDbOptions) {
    const memoryDbReadyPromise = createDelayedPromise<boolean>();
    const memoryDb = new SQLocalKysely({
      databasePath: ":memory:",
      onConnect: () => memoryDbReadyPromise.resolve(true),
    });

    const workerDbReadyPromise = createDelayedPromise<boolean>();
    const workerDb = new SQLocalKysely({
      databasePath: options.dbPath,
      onConnect: () => workerDbReadyPromise.resolve(true),
    });

    const readyPromise = Promise.all([
      memoryDbReadyPromise.promise,
      workerDbReadyPromise.promise,
    ]).then(() => {});

    const kysely = new Kysely<Database>({ dialect: memoryDb.dialect });

    return new SyncedDb<Database>(memoryDb, workerDb, readyPromise, kysely);
  }

  public async getQueriedTables(query: string) {
    const rootPages = (await this.memoryDb.sql(`EXPLAIN ${query}`))
      .filter(
        (x) => x.opcode === "OpenRead" && x.p3 === 0 && typeof x.p2 === "number"
      )
      .map((x) => x.p2);

    const tables = await this.memoryDb.sql(
      `SELECT DISTINCT tbl_name FROM sqlite_master WHERE rootpage IN (${rootPages.join(
        ","
      )})`
    );

    return tables.map((x) => x.tbl_name) as string[];
  }

  async getAllTables() {
    const tables = await this.memoryDb.sql(
      `SELECT * FROM sqlite_schema WHERE type = 'table'`
    );

    return tables
      .map((x) => x.tbl_name as string)
      .filter((x) => !x.startsWith("sqlite_"));
  }

  async watchQuery<Results = any[]>(
    query: string,
    callback: (result: Results) => void
  ) {
    const [tables] = await Promise.all([
      this.getQueriedTables(query),
      this.memoryDb.sql(query),
    ]);

    for (const table of tables) {
      this.registerTableListener(table, () => {});
    }
  }

  registerTableListener(table: string, callback: () => void) {
    if (!this.tableListeners.has(table)) {
      this.tableListeners.set(table, new Set());
    }

    this.tableListeners.get(table)!.add(callback);
    return () => {
      this.tableListeners.get(table)!.delete(callback);
    };
  }

  async initTableListeners() {
    const [tables] = await Promise.all([
      this.getAllTables(),
      this.memoryDb.createCallbackFunction(
        "table_changed",
        (tableName: string, type: "insert" | "update" | "delete") => {
          console.log(tableName, type);
        }
      ),
    ]);

    for (const table of tables) {
      await this.memoryDb.sql(`
        CREATE TEMP TRIGGER __${table}_insert AFTER INSERT ON ${table}
        BEGIN
          SELECT table_changed('${table}', 'insert');
        END;
  
        CREATE TEMP TRIGGER __${table}_update AFTER UPDATE ON ${table}
        BEGIN
          SELECT table_changed('${table}', 'update');
        END;
  
        CREATE TEMP TRIGGER __${table}_delete AFTER DELETE ON ${table}
        BEGIN
          SELECT table_changed('${table}', 'delete');
        END;
        `);
    }
  }
}

const dbAtom = atom(async () => {
  const db = await SyncedDb.create({ dbPath: "db.sqlite3" });

  await db.readyPromise;

  await seedDatabase(db.memoryDb);
  await seedDatabase(db.memoryDb);

  await db.initTableListeners();

  console.log(
    await db.getQueriedTables(
      "SELECT * FROM users INNER JOIN posts ON users.id = posts.user_id"
    )
  );

  return db;
});

export function App() {
  // Database initialization happens automatically via the atom
  const [db] = useAtom(dbAtom);

  const createRandomUser = async () => {
    await db.memoryDb.sql`
      INSERT INTO users (name, email) VALUES (${Math.random()
        .toString(36)
        .substring(2, 15)}, ${
      Math.random().toString(36).substring(2, 15) + "@example.com"
    })  
    `;
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-4">SQLite Sync Demo</h1>
      <p className="text-gray-600">
        Database initialized and seeded! Check the console for sample data.
      </p>
      <div className="mt-4 p-4 bg-gray-100 rounded">
        <p className="text-sm">
          ✅ Optimistic DB (in-memory) ready
          <br />
          ✅ Sync DB (persistent) ready
          <br />✅ Sample data seeded
        </p>
      </div>
      <button onClick={createRandomUser}>Create Random User</button>
    </div>
  );
}
