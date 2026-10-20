import { defineConfig } from "vitest/config";

// Resolve packages the way Metro does, so tests load the React Native entry of @sqlite-sync/core.
const conditions = ["react-native", "@sqlite-sync/source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
