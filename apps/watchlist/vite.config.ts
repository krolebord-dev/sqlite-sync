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
    // Keep Vite's default conditions (notably `browser`) alongside the workspace-source
    // condition. Listing only `@sqlite-sync/source` would drop `browser`, so deps like
    // @vercel/oidc (pulled in via `ai`) resolve to their Node build and crash in the browser.
    conditions: ["@sqlite-sync/source", "module", "browser", "development|production"],
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: { format: "es" },
});

export default config;
