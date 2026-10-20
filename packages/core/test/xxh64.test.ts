import fc from "fast-check";
import { describe, expect, it } from "vitest";
import initXxhash from "xxhash-wasm";
import { encodeUtf8, encodeUtf8Fallback, xxh64 } from "../src/xxh64";

const loneSurrogateString = fc.string({
  unit: fc.oneof(fc.constantFrom("\ud800", "\udbff", "\udc00", "\udfff"), fc.string({ unit: "binary" })),
});

describe("JS xxh64", () => {
  it("matches xxhash-wasm for arbitrary strings and seeds", async () => {
    const wasm = await initXxhash();
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 200 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (input, seed) => {
          expect(xxh64(encodeUtf8(input), seed)).toBe(wasm.h64(input, seed));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("matches xxhash-wasm on every length around the stripe boundaries", async () => {
    const wasm = await initXxhash();
    for (let length = 0; length <= 130; length++) {
      const input = "x".repeat(length);
      for (const seed of [0n, 1n]) {
        expect(xxh64(encodeUtf8(input), seed)).toBe(wasm.h64(input, seed));
      }
    }
  });

  it("matches xxhash-wasm on HLC timestamps", async () => {
    const wasm = await initXxhash();
    const timestamp = "1729300000000:0000000042:5f3c1d2a-7e4b-4c1e-9f0a-1b2c3d4e5f60";
    for (const seed of [0n, 1n]) {
      expect(xxh64(encodeUtf8(timestamp), seed)).toBe(wasm.h64(timestamp, seed));
    }
  });

  it("encodes UTF-8 like TextEncoder without it, including lone surrogates", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(loneSurrogateString, (input) => {
        expect(encodeUtf8Fallback(input)).toEqual(encoder.encode(input));
      }),
      { numRuns: 2000 },
    );
  });
});
