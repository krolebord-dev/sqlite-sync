import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [devtools(), cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), tanstackStart(), viteReact()],
  environments: {
    ssr: {
      optimizeDeps: {
        exclude: ["node:sqlite"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

export default config;
