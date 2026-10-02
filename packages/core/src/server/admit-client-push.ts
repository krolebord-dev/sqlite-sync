import { DEFAULT_MAX_DRIFT_MS } from "../hlc";
import type { MigratableEvent, SyncDbMigrator } from "../migrations/migrator";
import { type ClientDatasetRejectionReason, getClientDatasetRejection } from "../schema/admit-client-events";
import { validateNewCrdtEvent } from "../schema/validate-crdt-event";
import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { CRDT_EVENT_NO_OP_PAYLOAD, isNoOpCrdtEventPayload } from "../sqlite-crdt/crdt-table-schema";

export type PushedCrdtEvent = MigratableEvent & { timestamp: string };

export type PushRejectionReason =
  | "invalid-timestamp"
  | "timestamp-too-far-in-future"
  | "invalid-schema-version"
  | "schema-version-too-new"
  | "invalid-payload"
  | "migration-failed"
  | ClientDatasetRejectionReason
  | "schema-validation-failed";

export type PushRejection<T> = {
  event: T;
  reason: PushRejectionReason;
  errors?: string[];
};

export type AdmitClientPushResult<T> = {
  admitted: T[];
  rejected: PushRejection<T>[];
};

type AdmitClientPushOptions<T> = {
  syncDbSchema: Pick<SyncDbSchema, "tables" | "tablesConfig">;
  migrator: Pick<SyncDbMigrator, "migrateEvent" | "latestSchemaVersion">;
  events: readonly T[];
  now: number;
};

type AdmitEventResult<T> = { ok: true; event: T } | { ok: false; reason: PushRejectionReason; errors?: string[] };

const timestampPattern = /^\d{15}:[0-9a-z]{5}:.+$/;

/**
 * Checks a client push before the hub persists it. Admitted events are migrated to the latest
 * schema version, target a client-writable base table, and carry a payload that matches the
 * schema. No-op events only need a valid timestamp and schema version. Everything else is
 * rejected with a reason.
 */
export function admitClientPush<T extends PushedCrdtEvent>(opts: AdmitClientPushOptions<T>): AdmitClientPushResult<T> {
  const admitted: T[] = [];
  const rejected: PushRejection<T>[] = [];
  for (const event of opts.events) {
    const result = admitEvent(opts, event);
    if (result.ok) {
      admitted.push(result.event);
    } else {
      rejected.push({ event, reason: result.reason, ...(result.errors && { errors: result.errors }) });
    }
  }
  return { admitted, rejected };
}

function admitEvent<T extends PushedCrdtEvent>(opts: AdmitClientPushOptions<T>, event: T): AdmitEventResult<T> {
  const { migrator } = opts;

  if (!timestampPattern.test(event.timestamp)) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  if (Number(event.timestamp.slice(0, 15)) - opts.now > DEFAULT_MAX_DRIFT_MS) {
    return { ok: false, reason: "timestamp-too-far-in-future" };
  }
  if (!Number.isInteger(event.schema_version) || event.schema_version < 0) {
    return { ok: false, reason: "invalid-schema-version" };
  }
  if (event.schema_version > migrator.latestSchemaVersion) {
    return { ok: false, reason: "schema-version-too-new" };
  }
  if (isNoOpCrdtEventPayload(event.payload)) {
    return { ok: true, event };
  }
  const payload = parseJsonObject(event.payload);
  if (!payload) {
    return { ok: false, reason: "invalid-payload" };
  }

  let migrated: T | null;
  try {
    migrated = migrator.migrateEvent({ ...event });
  } catch (error) {
    return { ok: false, reason: "migration-failed", errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (!migrated) {
    return {
      ok: true,
      event: { ...event, schema_version: migrator.latestSchemaVersion, payload: CRDT_EVENT_NO_OP_PAYLOAD },
    };
  }

  const datasetRejection = getClientDatasetRejection(opts.syncDbSchema, migrated.dataset);
  if (datasetRejection) {
    return { ok: false, reason: datasetRejection };
  }

  const validation = validateNewCrdtEvent(opts.syncDbSchema, {
    ...migrated,
    payload: migrated.payload === event.payload ? payload : migrated.payload,
  });
  if (!validation.success) {
    return { ok: false, reason: "schema-validation-failed", errors: validation.errors };
  }

  return { ok: true, event: migrated };
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
