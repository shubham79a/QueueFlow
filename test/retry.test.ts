import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  closeConnections,
  db,
  effectStats,
  enqueue,
  killWorkers,
  redis,
  reset,
  spawnReceiver,
  spawnScheduler,
  spawnWorkers,
  waitFor,
  type SpawnedWorker,
} from "./helpers.js";

/**
 * Retries, backoff, and the dead-letter queue.
 *
 * These tests need three kinds of process running: workers to fail the job, a
 * scheduler to promote it when its backoff elapses, and a receiver whose /hook/flaky
 * route fails a set number of times and then succeeds. Without the scheduler nothing
 * moves a delayed job back, so a missing scheduler shows up as a timeout rather than
 * a wrong answer — which is itself the point of it being a separate process.
 *
 * RETRY_BASE_MS is set to 40 for the whole file, so a full five-attempt cycle
 * (2+4+8+16 units) completes in about 1.2 seconds instead of 30. Real time, small
 * units — no faked clock, so the scheduler's actual polling is exercised.
 */
const BASE_MS = 40;
process.env.RETRY_BASE_MS = String(BASE_MS);

const RECEIVER_PORT = 4101;
const hook = (path: string) => `http://127.0.0.1:${RECEIVER_PORT}${path}`;

async function jobRow(id: string) {
  const { rows } = await db.query<{
    status: string;
    attempts: number;
    last_error: string | null;
    next_run_at: Date | null;
  }>(
    "SELECT status, attempts, last_error, next_run_at FROM jobs WHERE id = $1",
    [id],
  );
  return rows[0]!;
}

const settled = (id: string) =>
  waitFor(
    async () => ["succeeded", "dead", "failed"].includes((await jobRow(id)).status),
    60_000,
    `job ${id.slice(0, 8)} to reach a terminal status`,
  );

describe("retries", () => {
  let procs: SpawnedWorker[] = [];

  beforeEach(async () => {
    await killWorkers(procs);
    procs = [];
    await reset();
  });

  afterAll(async () => {
    await killWorkers(procs);
    await closeConnections();
  });

  test("a transient failure is retried and eventually succeeds", async () => {
    const receiver = await spawnReceiver(RECEIVER_PORT);
    const scheduler = await spawnScheduler();
    const workers = await spawnWorkers(1);
    procs = [receiver, scheduler, ...workers];

    // Fails the first 2 deliveries of this job, succeeds on the 3rd.
    const [id] = await enqueue(1, "deliver_webhook", { url: hook("/hook/flaky/2") });
    await settled(id!);

    const row = await jobRow(id!);
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(3);
    expect(row.next_run_at).toBeNull();

    /**
     * The assertion that matters most in this file.
     *
     * A job that failed twice and then succeeded ran three times, but it produced
     * ONE successful outcome — so there must be exactly one effect row. If retries
     * wrote an effect per attempt, every correctness query in the project would
     * start reporting duplicates that are not duplicates.
     */
    const stats = await effectStats();
    expect(stats.total).toBe(1);
    expect(stats.duplicates).toBe(0);
  });

  test("a permanently failing job exhausts its attempts and lands in the DLQ", async () => {
    const scheduler = await spawnScheduler();
    const workers = await spawnWorkers(1);
    procs = [scheduler, ...workers];

    const [id] = await enqueue(1, "always_fail", { message: "receiver is gone" });
    await settled(id!);

    const row = await jobRow(id!);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(5); // max_attempts default
    expect(row.last_error).toContain("receiver is gone");
    expect(row.next_run_at).toBeNull();

    // It never succeeded, so it never had an effect.
    expect((await effectStats()).total).toBe(0);
  });

  test("the delay grows between attempts", async () => {
    const scheduler = await spawnScheduler();
    const workers = await spawnWorkers(1);
    procs = [scheduler, ...workers];

    const [id] = await enqueue(1, "always_fail", {});

    /**
     * Sample next_run_at while the job is cycling. Each observation is the delay
     * scheduled after attempt N, so the gaps should roughly double: 2, 4, 8, 16
     * units. Compared loosely — jitter adds up to 30% and the scheduler polls — but
     * a fixed delay or a broken exponent would fail this comfortably.
     */
    const delays: number[] = [];
    await waitFor(
      async () => {
        const row = await jobRow(id!);
        if (row.status === "retrying" && row.next_run_at) {
          const d = row.next_run_at.getTime() - Date.now();
          if (d > 0 && !delays.some((x) => Math.abs(x - d) < BASE_MS / 2)) delays.push(d);
        }
        return row.status === "dead";
      },
      60_000,
      "the job to exhaust its attempts",
    );

    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...delays)).toBeGreaterThan(Math.min(...delays) * 1.5);
  });

  test("a delayed job is parked in Redis, not held by the worker", async () => {
    const scheduler = await spawnScheduler();
    const workers = await spawnWorkers(1);
    procs = [scheduler, ...workers];

    await enqueue(1, "always_fail", {});

    /**
     * While a job is backing off it must be in the delayed sorted set and NOT
     * occupying the worker. If the worker slept through the backoff instead, the
     * delayed set would stay empty and the slot would be blocked.
     */
    await waitFor(
      async () => (await redis.zcard("queueflow:delayed")) > 0,
      20_000,
      "the job to appear in the delayed set",
    );

    // And the worker is free enough to take other work in the meantime.
    const [fast] = await enqueue(1, "sleep", { ms: 10 });
    await settled(fast!);
    expect((await jobRow(fast!)).status).toBe("succeeded");
  });

  test("a dead job can be replayed", async () => {
    const scheduler = await spawnScheduler();
    const workers = await spawnWorkers(1);
    procs = [scheduler, ...workers];

    const [id] = await enqueue(1, "always_fail", {});
    await settled(id!);
    expect((await jobRow(id!)).status).toBe("dead");

    /**
     * Replay does what POST /jobs/:id/replay does: reset the counter and requeue.
     * Done directly so the test does not also require the API process.
     */
    await db.query(
      `UPDATE jobs SET status='queued', attempts=0, last_error=NULL,
                       next_run_at=NULL, started_at=NULL, completed_at=NULL
        WHERE id=$1 AND status='dead'`,
      [id],
    );
    await redis.lpush("queueflow:pending", id!);

    // It is always_fail, so it dies again — but it genuinely ran again.
    await waitFor(
      async () => (await jobRow(id!)).attempts === 5 && (await jobRow(id!)).status === "dead",
      60_000,
      "the replayed job to exhaust its attempts again",
    );
  });
});
