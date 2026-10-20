import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "index.native": "src/index.native.ts",
    internal: "src/internal.ts",
    local: "src/local.ts",
    worker: "src/worker.ts",
    server: "src/server/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  fixedExtension: false,
  dts: {
    generator: "tsc",
    sourcemap: false,
  },
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: ["@sqlite.org/sqlite-wasm"],
  },
});
