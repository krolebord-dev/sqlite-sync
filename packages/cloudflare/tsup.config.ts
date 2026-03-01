import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    jobs: "src/jobs/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@sqlite-sync/core"],
});
