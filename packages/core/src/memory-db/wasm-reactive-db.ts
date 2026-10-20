import { createWasmMemoryDriver } from "../wasm-driver";
import { SQLiteReactiveDb, type SQLiteReactiveDbOptions } from "./sqlite-reactive-db";

export async function createSQLiteReactiveDb<Database>(opts: Omit<SQLiteReactiveDbOptions, "driver">) {
  const driver = await createWasmMemoryDriver();
  return SQLiteReactiveDb.create<Database>({ ...opts, driver });
}
