import { describe, expect, it } from "vitest";
import { HLCCounter, serializeHLC } from "../src/hlc";

const MAX_COUNTER = parseInt("zzzzz", 36);

describe("HLCCounter counter overflow", () => {
  it("rolls over to the next millisecond when a local tick passes the max counter", () => {
    const hlc = new HLCCounter("node", () => 1_000);
    hlc.restoreHLC({ timestamp: 1_000, counter: MAX_COUNTER, nodeId: "node" });

    expect(hlc.getNextHLC()).toEqual({ timestamp: 1_001, counter: 0, nodeId: "node" });
  });

  it.each([MAX_COUNTER, MAX_COUNTER - 1])("orders later local timestamps after a merged counter of %i", (counter) => {
    const hlc = new HLCCounter("node", () => 1_000);
    const remote = { timestamp: 61_000, counter, nodeId: "remote" };

    hlc.mergeHLC(remote);
    const first = hlc.getNextHLC();
    const second = hlc.getNextHLC();

    expect(serializeHLC(first) > serializeHLC(remote)).toBe(true);
    expect(serializeHLC(second) > serializeHLC(first)).toBe(true);
  });
});
