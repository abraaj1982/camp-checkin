import { defineConfig } from "vitest/config";

// Integration tests run against a real local Postgres (architecture doc
// Decision 5: local/Docker dev) — DATABASE_URL here must point at a
// disposable database; tests truncate all tables before every test file.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://recruitment:recruitment@localhost:5432/recruitment_platform",
      SESSION_SECRET: "test-session-secret-not-for-production-use-only",
      NODE_ENV: "test",
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // All test files share one real Postgres database and each resets it
    // in beforeEach; running files in parallel lets one file's reset wipe
    // rows another file mid-test is relying on. Force sequential execution
    // instead of standing up a throwaway DB per worker.
    fileParallelism: false,
  },
});
