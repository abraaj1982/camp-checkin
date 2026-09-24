import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component tests for the read-only Evidence Viewer (Phase 5B). jsdom only
// here — apps/api and worker's integration tests run against a real
// Postgres in a Node environment (worker/vitest.config.ts) and are
// untouched by this file.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
