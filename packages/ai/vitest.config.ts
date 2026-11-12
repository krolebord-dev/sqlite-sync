import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@sqlite-sync/source"],
  },
  test: {
    projects: [
      { extends: true, test: { name: "ai-v6" } },
      { extends: true, test: { name: "ai-v7" }, resolve: { alias: { ai: "ai-v7" } } },
    ],
  },
});
