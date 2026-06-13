import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import type { CrdtEventType, NewCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import type { AnyTableBuilder } from "./table-builder";

export type NewCrdtEventValidationResult =
  | { success: true; event: NewCrdtEvent }
  | { success: false; errors: string[] };

const crdtEventTypes = ["item-created", "item-updated", "item-deleted"] as const;

export function validateNewCrdtEvent(
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig">,
  input: unknown,
): NewCrdtEventValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { success: false, errors: ["Event must be an object"] } satisfies NewCrdtEventValidationResult;
  }

  const type = input.type;
  const dataset = input.dataset;
  const itemId = input.item_id;
  const payload = input.payload;

  if (!isCrdtEventType(type)) {
    errors.push(`Invalid event type "${String(type)}"`);
  }
  if (typeof dataset !== "string") {
    errors.push(`Event dataset must be a string`);
  }
  if (typeof itemId !== "string") {
    errors.push(`Event item_id must be a string`);
  }
  if (!isRecord(payload)) {
    errors.push(`Event payload must be an object`);
  }

  const datasetMatch = typeof dataset === "string" ? findTableForDataset(schema, dataset) : null;
  if (typeof dataset === "string" && !datasetMatch) {
    errors.push(`Unknown dataset "${dataset}"`);
  }

  if (isCrdtEventType(type) && datasetMatch && isRecord(payload)) {
    switch (type) {
      case "item-created": {
        const result = datasetMatch.table.validatePayload(payload, { event: "item-created" });
        if (!result.success) {
          errors.push(...result.errors.map((error) => `payload: ${error}`));
        }
        if (typeof itemId === "string" && "id" in payload && payload.id !== itemId) {
          errors.push(`payload: Column "id" must match item_id "${itemId}"`);
        }
        break;
      }
      case "item-updated": {
        const result = datasetMatch.table.validatePayload(payload, { event: "item-updated" });
        if (!result.success) {
          errors.push(...result.errors.map((error) => `payload: ${error}`));
        }
        break;
      }
      case "item-deleted":
        if (Object.keys(payload).length > 0) {
          errors.push(`payload: item-deleted events must have an empty payload`);
        }
        break;
    }
  }

  if (errors.length > 0) {
    return { success: false, errors } satisfies NewCrdtEventValidationResult;
  }

  return {
    success: true,
    event: {
      type: type as CrdtEventType,
      dataset: datasetMatch?.baseTableName ?? (dataset as string),
      item_id: itemId as string,
      payload: payload as Record<string, unknown>,
    },
  } satisfies NewCrdtEventValidationResult;
}

function findTableForDataset(
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig">,
  dataset: string,
): { table: AnyTableBuilder; baseTableName: string } | null {
  const config = schema.tablesConfig.find(
    (tableConfig) => tableConfig.baseTableName === dataset || tableConfig.crdtTableName === dataset,
  );
  if (config) {
    const table = schema.tables[config.crdtTableName];
    return table ? { table, baseTableName: config.baseTableName } : null;
  }
  const table = schema.tables[dataset];
  return table ? { table, baseTableName: dataset } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCrdtEventType(value: unknown): value is CrdtEventType {
  return typeof value === "string" && crdtEventTypes.includes(value as CrdtEventType);
}
