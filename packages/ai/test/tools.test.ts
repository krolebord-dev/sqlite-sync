import { describe, expect, it } from "vitest";
import { createDbTools } from "../src/tools";

describe("createDbTools", () => {
  it("exposes only the getDbSchema tool in phase 1", () => {
    const tools = createDbTools({ access: () => ({ getSchemaDoc: () => "doc" }) });
    expect(Object.keys(tools)).toEqual(["getDbSchema"]);
    expect(tools.getDbSchema?.description).toBeTruthy();
  });

  it("resolves the access factory on every call and awaits async docs", async () => {
    let accessCalls = 0;
    const tools = createDbTools({
      access: async () => {
        accessCalls++;
        return { getSchemaDoc: async () => `doc ${accessCalls}` };
      },
    });

    const execute = tools.getDbSchema?.execute;
    if (!execute) throw new Error("getDbSchema tool must be executable");

    await expect(execute({}, { toolCallId: "call-1", messages: [] })).resolves.toBe("doc 1");
    await expect(execute({}, { toolCallId: "call-2", messages: [] })).resolves.toBe("doc 2");
    expect(accessCalls).toBe(2);
  });
});
