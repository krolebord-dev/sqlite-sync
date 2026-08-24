import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { resolveAiPolicy } from "../src/policy";

const migrations = createMigrations(() => ({ 0: [] }));

const syncDbSchema = defineSyncSchema({
  tables: {
    todos: t.table({ title: t.text() }),
    audit: t.table({ note: t.text() }, { ai: "read-only" }),
    billing: t.table({ card: t.text() }, { ai: "hidden" }),
  },
  migrations,
});

describe("resolveAiPolicy", () => {
  it("defaults to read-write and reads declared access off the builders", () => {
    const policy = resolveAiPolicy({ syncDbSchema });

    expect(policy.tableAccess("todos")).toBe("read-write");
    expect(policy.tableAccess("audit")).toBe("read-only");
    expect(policy.tableAccess("billing")).toBe("hidden");
    expect(policy.hasHiddenTables).toBe(true);
    expect(policy.readableBaseTableNames).toEqual(["_todos", "_audit"]);
  });

  it("resolves base and crdt table names to the same policy", () => {
    const policy = resolveAiPolicy({ syncDbSchema });

    expect(policy.tableAccess("_audit")).toBe("read-only");
    expect(policy.tableAccess("_billing")).toBe("hidden");
  });

  it("treats unknown datasets as hidden", () => {
    const policy = resolveAiPolicy({ syncDbSchema });

    expect(policy.tableAccess("nope")).toBe("hidden");
  });

  it("reports no hidden tables when nothing is hidden", () => {
    const openSchema = defineSyncSchema({
      tables: { todos: t.table({ title: t.text() }) },
      migrations,
    });

    expect(resolveAiPolicy({ syncDbSchema: openSchema }).hasHiddenTables).toBe(false);
  });
});
