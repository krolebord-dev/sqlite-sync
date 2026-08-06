import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  fixedExtension: false,
  dts: {
    sourcemap: false,
  },
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: ["@sqlite-sync/core"],
  },
});
