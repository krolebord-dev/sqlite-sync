import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

export const dummyKysely: Kysely<any> = new Kysely({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createIntrospector: (db) => new SqliteIntrospector(db),
  },
});
