import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { createWasmMemoryDriver } from "../wasm-driver";
import { type SchemaVerificationIssue, verifySyncSchemaWithDriver } from "./verify-sync-schema";

/** {@link verifySyncSchemaWithDriver} on a throwaway in-memory sqlite-wasm database. */
export async function verifySyncSchema(schema: SyncDbSchema): Promise<SchemaVerificationIssue[]> {
  return verifySyncSchemaWithDriver(schema, await createWasmMemoryDriver());
}
