import initXxhash, { type XXHashAPI } from "xxhash-wasm";
import { encodeUtf8, xxh64 } from "./xxh64";

type Hasher = {
  h64: (input: string, seed: bigint) => bigint;
};

let loadPromise: Promise<void> | null = null;
let hasher: Hasher | null = null;

const jsHasher: Hasher = {
  h64: (input, seed) => xxh64(encodeUtf8(input), seed),
};

function createWasmHasher(api: XXHashAPI): Hasher {
  return {
    h64: (input, seed) => api.h64(input, seed),
  };
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    if (typeof WebAssembly === "undefined") {
      hasher = jsHasher;
      loadPromise = Promise.resolve();
    } else {
      // Instantiation can still fail, e.g. under a CSP without 'wasm-unsafe-eval'; the JS hasher gives the same hashes.
      loadPromise = initXxhash().then(
        (api) => {
          hasher = createWasmHasher(api);
        },
        () => {
          hasher = jsHasher;
        },
      );
    }
  }
  return loadPromise;
}

function getHasher() {
  if (!hasher) {
    throw new Error("xxhash is not initialized; call xxhash.ensureLoaded() first");
  }
  return hasher;
}

function h64(input: string, seed = 0n): bigint {
  return getHasher().h64(input, seed);
}

export const xxhash = {
  ensureLoaded,
  h64,
};
