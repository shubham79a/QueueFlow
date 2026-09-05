import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],

    /**
     * These are not unit tests. Each one spawns real worker processes and talks to
     * the real Redis and Postgres from docker compose, because the behaviour under
     * test IS the interaction between two real servers — a mocked Redis would
     * happily "prove" that two workers never receive the same job, since the mock
     * is whatever we wrote it to be.
     *
     * Consequences of that choice, encoded below:
     */

    // Spawning processes, enqueuing 100 jobs and waiting for a drain is slow.
    testTimeout: 120_000,
    hookTimeout: 60_000,

    /**
     * One file at a time, one worker. Every test truncates the jobs tables and
     * clears the pending list, so two running in parallel would delete each
     * other's data and fail in a way that looks exactly like a real duplicate-job
     * bug — the worst kind of flake, because it accuses the code under test.
     */
    fileParallelism: false,
    maxWorkers: 1,
  },
});
