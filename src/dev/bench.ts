import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { KEYS } from "../shared/keys.js";

/**
 * Throughput sweep.
 *
 * Runs the same workload at several worker/concurrency settings and reports
 * jobs per second alongside queue wait, computed from the timestamps the jobs
 * table already records.
 *
 * The number to look for is NOT the peak. It is the row where jobs/s stops rising
 * while p99 queue wait keeps climbing — that is the point where the bottleneck
 * stopped being this system's capacity and moved somewhere else. Being able to
 * name where it moved is worth more than any single figure:
 *
 *   "It plateaued at 3 workers because the bottleneck moved to X"
 *
 * beats "it does about 30 jobs a second".
 *
 * Queue wait and execution time are reported separately on purpose. Queue wait
 * (started_at - created_at) measures THIS SYSTEM; execution time
 * (completed_at - started_at) measures THE WORK. Adding them together and calling
 * the result latency is the standard benchmarking mistake, because it hides which
 * of the two you could actually do something about.
 */
const here = dirname(fileURLToPath(import.meta.url));
const workerEntry = resolve(here, "../worker/index.ts");

const JOBS = Number(process.env.BENCH_JOBS ?? 300);
const JOB_MS = Number(process.env.BENCH_JOB_MS ?? 100);

// workers x concurrency
const MATRIX: Array<[number, number]> = [
  [1, 1],
  [1, 5],
  [1, 20],
  [3, 1],
  [3, 5],
  [3, 20],
];

const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});
const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://queueflow:queueflow@127.0.0.1:5433/queueflow",
  max: 6,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnWorkers(count: number, concurrency: number): ChildProcess[] {
  return Array.from({ length: count }, (_, i) =>
    spawn(process.execPath, ["--import", "tsx", "--env-file=.env", workerEntry], {
      env: { ...process.env, WORKER_ID: `w${i + 1}`, CONCURRENCY: String(concurrency) },
      stdio: "ignore",
    }),
  );
}

async function killAll(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((done) => {
          if (c.exitCode !== null) return done();
          c.once("exit", () => done());
          c.kill("SIGKILL");
        }),
    ),
  );
}

async function run(workers: number, concurrency: number) {
  await db.query("TRUNCATE job_effects, jobs");
  await redis.del(KEYS.pending);

  /**
   * Enqueue the whole backlog BEFORE any worker exists.
   *
   * The first version of this spawned workers first and started the clock after
   * the enqueue loop — so the workers drained while the loop was still inserting,
   * and at high concurrency almost everything was finished before timing began.
   * It reported 2381 jobs/s for a workload whose floor is ~0.5s. A benchmark that
   * flatters you is worse than none.
   *
   * With no consumer running, the full backlog is in place before anything starts,
   * so what follows is drain rate.
   */
  for (let i = 0; i < JOBS; i++) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO jobs (id, type, payload, status) VALUES ($1, 'sleep', $2, 'queued')",
      [id, JSON.stringify({ ms: JOB_MS })],
    );
    await redis.lpush(KEYS.pending, id);
  }

  const children = spawnWorkers(workers, concurrency);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM jobs WHERE status IN ('succeeded','failed','dead')",
    );
    if (Number(rows[0]!.n) >= JOBS) break;
    await sleep(50);
  }

  /**
   * Elapsed comes from the database, not from a stopwatch in this process:
   * first job started -> last job completed. That excludes both the enqueue loop
   * and worker boot time, neither of which is throughput.
   */
  const { rows } = await db.query<Record<string, string>>(`
    SELECT
      COUNT(*)::text AS done,
      EXTRACT(EPOCH FROM (MAX(completed_at) - MIN(started_at)))::text  AS drain_secs,
      percentile_cont(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)))::text   AS p50_wait,
      percentile_cont(0.99) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)))::text   AS p99_wait,
      percentile_cont(0.99) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)))::text AS p99_exec
    FROM jobs WHERE status = 'succeeded'
  `);
  const r = rows[0]!;
  const elapsed = Math.max(Number(r.drain_secs), 0.001);

  const dupes = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT job_id FROM job_effects GROUP BY job_id HAVING COUNT(*) > 1) d`,
  );

  await killAll(children);

  return {
    workers,
    concurrency,
    jobsPerSec: Number(r.done) / elapsed,
    p50Wait: Number(r.p50_wait),
    p99Wait: Number(r.p99_wait),
    p99Exec: Number(r.p99_exec),
    duplicates: Number(dupes.rows[0]!.n),
  };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`\n${JOBS} jobs of ${JOB_MS}ms each, enqueued up front, timed to drain.\n`);
console.log("workers  conc   jobs/s   p50 wait   p99 wait   p99 exec   dupes");
console.log("───────────────────────────────────────────────────────────────");

for (const [workers, concurrency] of MATRIX) {
  const m = await run(workers, concurrency);
  console.log(
    `${pad(m.workers, 7)}  ${pad(m.concurrency, 4)}   ${pad(m.jobsPerSec.toFixed(1), 6)}` +
      `   ${pad(m.p50Wait.toFixed(2) + "s", 8)}   ${pad(m.p99Wait.toFixed(2) + "s", 8)}` +
      `   ${pad(m.p99Exec.toFixed(2) + "s", 8)}   ${pad(m.duplicates, 5)}`,
  );
}

console.log(
  "\nRead the table for where jobs/s flattens while p99 wait keeps rising —\n" +
    "that is the bottleneck leaving this system. dupes must be 0 in every row.\n",
);

await db.end();
redis.disconnect();
