import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { KEYS } from "../src/shared/keys.js";
import type { JobType } from "../src/shared/types.js";

/**
 * Shared test harness.
 *
 * Everything here operates on the real Redis and Postgres, and spawns real worker
 * processes. That is deliberate: the claims being tested are about what happens
 * when several OS processes race for the same Redis list, and no in-process
 * simulation can be evidence for that.
 *
 * The Phase 5 crash tests will reuse all of it — killing a worker mid-job needs
 * exactly this ability to spawn and SIGKILL a real process.
 */
const here = dirname(fileURLToPath(import.meta.url));
const workerEntry    = resolve(here, "../src/worker/index.ts");
const schedulerEntry = resolve(here, "../src/scheduler/index.ts");
const receiverEntry  = resolve(here, "../src/receiver/index.ts");

/**
 * Every spawned process is a real one, started the same way. Retry tests need the
 * scheduler (nothing promotes a delayed job without it) and the receiver (the
 * flaky endpoint is what produces a transient failure on demand).
 */
function spawnProcess(entry: string, env: Record<string, string>) {
  const output: string[] = [];
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--env-file=.env", entry],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (c: Buffer) => output.push(c.toString()));
  child.stderr?.on("data", (c: Buffer) => output.push(c.toString()));
  return { child, output };
}

/** Start the retry scheduler and wait until it is watching the delayed set. */
export async function spawnScheduler(): Promise<SpawnedWorker> {
  const { child, output } = spawnProcess(schedulerEntry, { SCHEDULER_ID: "s1" });
  const w: SpawnedWorker = { id: "s1", child, output };
  await waitFor(() => output.join("").includes("scheduler s1 up"), 30_000, "scheduler to start");
  return w;
}

/** Start the webhook receiver and wait until it is listening. */
export async function spawnReceiver(port = 4101): Promise<SpawnedWorker> {
  const { child, output } = spawnProcess(receiverEntry, { RECEIVER_PORT: String(port) });
  const w: SpawnedWorker = { id: "recv", child, output };
  await waitFor(() => output.join("").includes("webhook receiver on"), 30_000, "receiver to start");
  return w;
}

export const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

export const db = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://queueflow:queueflow@127.0.0.1:5433/queueflow",
  max: 4,
});

/** Wipe both stores so a rerun means something. */
export async function reset(): Promise<void> {
  await db.query("TRUNCATE job_effects, jobs");
  await redis.del(KEYS.pending, KEYS.delayed);
}

export interface SpawnedWorker {
  id: string;
  child: ChildProcess;
  output: string[];
}

/** Start `count` worker processes with distinct ids, and wait until each is listening. */
export async function spawnWorkers(count: number, concurrency = 1): Promise<SpawnedWorker[]> {
  const workers: SpawnedWorker[] = [];

  for (let i = 1; i <= count; i++) {
    const id = `w${i}`;
    const output: string[] = [];

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--env-file=.env", workerEntry],
      {
        env: { ...process.env, WORKER_ID: id, CONCURRENCY: String(concurrency) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.on("data", (c: Buffer) => output.push(c.toString()));
    child.stderr?.on("data", (c: Buffer) => output.push(c.toString()));

    workers.push({ id, child, output });
  }

  // Wait until every worker has actually reached its BRPOP, otherwise jobs
  // enqueued immediately would all be taken by whichever process booted first and
  // the test would prove nothing about distribution.
  await Promise.all(
    workers.map((w) =>
      waitFor(() => w.output.join("").includes(`worker ${w.id} up`), 30_000, `${w.id} to start`),
    ),
  );

  return workers;
}

/** SIGTERM every worker and wait for the processes to actually be gone. */
export async function killWorkers(workers: SpawnedWorker[]): Promise<void> {
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((done) => {
          if (w.child.exitCode !== null || w.child.signalCode !== null) return done();
          w.child.once("exit", () => done());
          w.child.kill("SIGKILL");
        }),
    ),
  );
}

/**
 * Enqueue jobs the same way the API does — insert the row, then push the id.
 * Done directly rather than over HTTP so the tests do not also require the API to
 * be running.
 */
export async function enqueue(
  count: number,
  type: JobType = "sleep",
  payload: unknown = { ms: 50 },
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO jobs (id, type, payload, status) VALUES ($1, $2, $3, 'queued')",
      [id, type, JSON.stringify(payload)],
    );
    await redis.lpush(KEYS.pending, id);
    ids.push(id);
  }
  return ids;
}

/** Wait until every job has reached a terminal status. */
export async function waitForDrain(expected: number, timeoutMs = 90_000): Promise<void> {
  await waitFor(
    async () => {
      const { rows } = await db.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM jobs WHERE status IN ('succeeded','failed','dead')",
      );
      return Number(rows[0]?.n ?? 0) >= expected;
    },
    timeoutMs,
    `${expected} jobs to finish`,
  );
}

export async function effectStats(): Promise<{
  total: number;
  duplicates: number;
  distinctWorkers: number;
  perWorker: Record<string, number>;
}> {
  const total = await one("SELECT COUNT(*)::text AS v FROM job_effects");
  const duplicates = await one(
    `SELECT COUNT(*)::text AS v FROM (
       SELECT job_id FROM job_effects GROUP BY job_id HAVING COUNT(*) > 1
     ) d`,
  );
  const distinctWorkers = await one("SELECT COUNT(DISTINCT worker_id)::text AS v FROM job_effects");

  const { rows } = await db.query<{ worker_id: string; n: string }>(
    "SELECT worker_id, COUNT(*)::text AS n FROM job_effects GROUP BY worker_id ORDER BY worker_id",
  );

  return {
    total,
    duplicates,
    distinctWorkers,
    perWorker: Object.fromEntries(rows.map((r) => [r.worker_id, Number(r.n)])),
  };
}

async function one(sql: string): Promise<number> {
  const { rows } = await db.query<{ v: string }>(sql);
  return Number(rows[0]?.v ?? 0);
}

/** Poll a condition until true, or fail with a message that says what was awaited. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

export async function closeConnections(): Promise<void> {
  await db.end();
  redis.disconnect();
}
