import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
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
    neverBundle: ["react", "kysely", "@sqlite-sync/core"],
  },
});
