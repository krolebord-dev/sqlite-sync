import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [
    devtools(),
    cloudflare(),
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    viteReact(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    // sqlite-wasm can't be pre-bundled (WASM). The packages that import it must
    // also be excluded, otherwise Vite pre-bundles them with a bare
    // "@sqlite.org/sqlite-wasm" import it can't resolve from .vite/deps.
    exclude: ["@sqlite.org/sqlite-wasm", "@sqlite-sync/core"],
  },
  worker: { format: "es" },
});

export default config;
