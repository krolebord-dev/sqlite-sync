import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XXHashAPI } from "xxhash-wasm";

const wasmLoad = vi.hoisted(() => ({ fail: false }));

vi.mock("xxhash-wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xxhash-wasm")>();
  return {
    default: () => (wasmLoad.fail ? Promise.reject(new Error("wasm blocked")) : actual.default()),
  };
});

const inputs = ["", "a", "1729300000000:0000000042:5f3c1d2a-7e4b-4c1e-9f0a-1b2c3d4e5f60", "ünïcødé 😀 \ud800"];

let reference: XXHashAPI;

async function loadHash() {
  vi.resetModules();
  const { xxhash } = await import("../src/hash");
  await xxhash.ensureLoaded();
  return xxhash;
}

function expectReferenceHashes(xxhash: Awaited<ReturnType<typeof loadHash>>) {
  for (const input of inputs) {
    expect(xxhash.h64(input, 7n)).toBe(reference.h64(input, 7n));
    expect(xxhash.h64Concat(input)).toBe(reference.h64(input, 0n) | (reference.h64(input, 1n) << 64n));
  }
}

describe("xxhash", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("xxhash-wasm")>("xxhash-wasm");
    reference = await actual.default();
  });

  afterEach(() => {
    wasmLoad.fail = false;
    vi.unstubAllGlobals();
  });

  it("hashes with xxhash-wasm when WebAssembly is available", async () => {
    expectReferenceHashes(await loadHash());
  });

  it("uses the JS implementation without WebAssembly", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    expectReferenceHashes(await loadHash());
  });

  it("falls back to the JS implementation when the wasm module fails to load", async () => {
    wasmLoad.fail = true;
    expectReferenceHashes(await loadHash());
  });
});
