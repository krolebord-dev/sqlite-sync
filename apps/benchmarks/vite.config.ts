import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, "index.html"),
        sqliteBatchInserts: path.resolve(rootDir, "sqlite-batch-inserts/index.html"),
        sqliteTransactionOverhead: path.resolve(rootDir, "sqlite-transaction-overhead/index.html"),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: { format: "es" },
  resolve: {
    conditions: ["@sqlite-sync/source"],
  },
});
