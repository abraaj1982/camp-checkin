import { defineConfig } from "vitest/config";

// Integration tests here exercise the real pipeline against a real local
// Postgres (architecture doc Decision 5) and a temp-dir LocalObjectStorage
// — never a live Claude call (a FakeAIProvider stands in). Multiple test
// files share one database and reset it, so run sequentially, same as
// apps/api/vitest.config.ts.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://recruitment:recruitment@localhost:5432/recruitment_platform",
      NODE_ENV: "test",
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
