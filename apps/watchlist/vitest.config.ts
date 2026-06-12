import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@sqlite-sync/source"],
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
