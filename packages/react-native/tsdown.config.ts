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
    neverBundle: [
      "@op-engineering/op-sqlite",
      "@sqlite-sync/core",
      "kysely",
      "react-native",
      "react-native-get-random-values",
    ],
  },
});
