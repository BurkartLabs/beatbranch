import { defineConfig } from "vitest/config";
import { MAX_WORKERS } from "./scripts/test-workers.mjs";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Each test file gets a fresh module graph; every database test gets a database of its own (tests/test-db.ts).
    pool: "forks",
    maxWorkers: MAX_WORKERS,
    globalSetup: ["tests/test-db-template.ts"],
    // The network is off in every test; every temporary folder and database a test made is removed when its file ends.
    setupFiles: ["tests/no-network.ts", "tests/temp-dir-setup.ts", "tests/test-db-setup.ts"],
    testTimeout: 20000,
    // A file's setup copies a database and builds the app: under a saturated machine (four Builders' suites at once,
    // 2026-09-27) that took over 10 s. Setup gets time; no test asserts a duration (P-STOPWATCH-TEST).
    hookTimeout: 60000
  }
});
