import { verifySyncSchema } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { syncDbSchema } from "./migrations";

describe("list db schema", () => {
  it("migrations produce the declared schema", async () => {
    expect(await verifySyncSchema(syncDbSchema)).toEqual([]);
  });
});
