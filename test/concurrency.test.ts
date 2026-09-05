import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  closeConnections,
  effectStats,
  enqueue,
  killWorkers,
  reset,
  spawnWorkers,
  waitForDrain,
  type SpawnedWorker,
} from "./helpers.js";

/**
 * The claim: several worker processes can race for the same Redis list, and no
 * job will ever run twice or be skipped.
 *
 * This is the phase where job_effects stops being a formality. Until now every
 * job was handled by one worker running one job at a time, so "did anything run
 * twice" could only ever answer no. With three processes competing for the same
 * list, it is a real question.
 *
 * Note what is NOT tested here: a lock. There isn't one. Redis is single-threaded,
 * so concurrent BRPOPs are serialised by the server and an element goes to exactly
 * one caller. These tests exist to confirm that guarantee holds in practice, not
 * to check code we wrote.
 */
describe("multiple workers", () => {
  let workers: SpawnedWorker[] = [];

  beforeEach(async () => {
    await killWorkers(workers);
    workers = [];
    await reset();
  });

  afterAll(async () => {
    await killWorkers(workers);
    await closeConnections();
  });

  test("3 workers drain 100 jobs with no duplicates and no losses", async () => {
    workers = await spawnWorkers(3);
    await enqueue(100, "sleep", { ms: 20 });
    await waitForDrain(100);

    const stats = await effectStats();

    // Exactly one execution per job — nothing lost.
    expect(stats.total).toBe(100);

    // No job_id appears twice — no two workers ever got the same job.
    expect(stats.duplicates).toBe(0);

    /**
     * All three actually did work.
     *
     * This assertion matters as much as the other two: 100 rows all written by w1
     * would satisfy both checks above while proving that w2 and w3 never received
     * anything — which would mean the test was measuring a single worker and the
     * whole exercise was worthless.
     */
    expect(stats.distinctWorkers).toBe(3);

    // Every job reached 'succeeded' — no silent failures hiding behind the counts.
    const { rows } = await (await import("./helpers.js")).db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM jobs WHERE status = 'succeeded'",
    );
    expect(Number(rows[0]!.n)).toBe(100);
  });

  test("in-process concurrency runs jobs in parallel, not in sequence", async () => {
    /**
     * One worker, concurrency 5, ten jobs of 1 second each.
     *
     *   sequential -> ~10s
     *   concurrent -> ~2s   (two batches of five)
     *
     * The threshold is 5s: comfortably above the concurrent case and comfortably
     * below the sequential one, so the test does not fail on a slow machine but
     * would fail if the semaphore were ignored and jobs ran one at a time.
     */
    workers = await spawnWorkers(1, 5);

    const startedAt = Date.now();
    await enqueue(10, "sleep", { ms: 1000 });
    await waitForDrain(10);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5_000);

    const stats = await effectStats();
    expect(stats.total).toBe(10);
    expect(stats.duplicates).toBe(0);
  });

  test("a worker takes only as much work as it has capacity for", async () => {
    /**
     * Backpressure. One worker, concurrency 2, six slow jobs.
     *
     * A worker that popped eagerly would drain the Redis list immediately and
     * buffer the jobs in memory — `llen` would read 0 while six jobs waited
     * invisibly inside one process, unavailable to any other worker and lost
     * entirely if it crashed.
     *
     * Because a slot is acquired BEFORE the pop, work this process cannot start
     * stays in Redis where it is visible and claimable.
     */
    workers = await spawnWorkers(1, 2);
    await enqueue(6, "sleep", { ms: 1500 });

    // Let it settle into a steady state: 2 in flight, the rest still queued.
    await new Promise((r) => setTimeout(r, 800));

    const { redis } = await import("./helpers.js");
    const stillQueued = await redis.llen("queueflow:pending");

    // 6 enqueued, at most 2 claimed, so several must remain in Redis.
    expect(stillQueued).toBeGreaterThan(0);

    await waitForDrain(6);
    expect((await effectStats()).duplicates).toBe(0);
  });
});
