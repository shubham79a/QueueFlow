import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { KEYS, scanKeys } from "../src/shared/keys.js";
import type { JobRow, JobType } from "../src/shared/types.js";

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
export async function spawnScheduler(env: Record<string, string> = {}): Promise<SpawnedWorker> {
  const { child, output } = spawnProcess(schedulerEntry, { SCHEDULER_ID: "s1", ...env });
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

/**
 * Wipe both stores so a rerun means something.
 *
 * The processing lists and heartbeat keys have to go too. A leftover
 * `queueflow:processing:w1` from a crash test would be found by the next test's
 * reaper and its ids pushed into pending — jobs from a previous run appearing in
 * the middle of the next one, which is the kind of failure that takes an evening
 * to understand.
 */
export async function reset(): Promise<void> {
  await db.query("TRUNCATE job_effects, jobs");
  await redis.del(KEYS.pending, KEYS.delayed);

  const stale = [
    ...(await scanKeys(redis, KEYS.processingPattern)),
    ...(await scanKeys(redis, KEYS.alivePattern)),
  ];
  if (stale.length > 0) await redis.del(...stale);
}

/** The ids one worker is holding right now. */
export async function processingList(workerId: string): Promise<string[]> {
  return redis.lrange(KEYS.processing(workerId), 0, -1);
}

/** The ids waiting to be picked up. */
export async function pendingList(): Promise<string[]> {
  return redis.lrange(KEYS.pending, 0, -1);
}

/**
 * Seconds left on a worker's heartbeat. -2 means the key is gone, which is the
 * system's entire definition of "that worker is dead".
 */
export async function aliveTtl(workerId: string): Promise<number> {
  return redis.ttl(KEYS.alive(workerId));
}

/** One job row, or undefined. */
export async function jobRow(id: string): Promise<JobRow | undefined> {
  const { rows } = await db.query<JobRow>(
    `SELECT id, type, payload, status, attempts, max_attempts, last_error,
            idempotency_key, created_at, started_at, completed_at, next_run_at, lease_id
       FROM jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** How many times this job actually ran, according to the proof table. */
export async function effectsFor(jobId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM job_effects WHERE job_id = $1",
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface SpawnedWorker {
  id: string;
  child: ChildProcess;
  output: string[];
}

/**
 * Start ONE worker with a chosen id and environment, and wait until it is waiting
 * on the queue.
 *
 * The env override is what makes the crash tests possible. A worker given
 * HEARTBEAT_TTL_S=1 and HEARTBEAT_INTERVAL_MS=60000 is perfectly healthy and
 * still stops proving it within a second — which is how a test reproduces "the
 * detector was wrong about a living process" without having to arrange a real
 * garbage-collection pause.
 */
export async function spawnWorker(
  id: string,
  env: Record<string, string> = {},
): Promise<SpawnedWorker> {
  const { child, output } = spawnProcess(workerEntry, {
    WORKER_ID: id,
    CONCURRENCY: "1",
    ...env,
  });

  const w: SpawnedWorker = { id, child, output };
  await waitFor(() => output.join("").includes(`worker ${id} up`), 30_000, `${id} to start`);
  return w;
}

/** Start `count` worker processes with distinct ids, and wait until each is listening. */
export async function spawnWorkers(
  count: number,
  concurrency = 1,
  env: Record<string, string> = {},
): Promise<SpawnedWorker[]> {
  // Started together rather than one after another, because waiting for each to
  // report "up" in turn would serialise several seconds of process startup.
  //
  // Every worker must have reached the queue before the test enqueues anything:
  // jobs pushed while only the first process was listening would all go to that
  // one, and a test about distribution would prove nothing.
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      spawnWorker(`w${i + 1}`, { CONCURRENCY: String(concurrency), ...env }),
    ),
  );
}

/**
 * SIGKILL one process and wait until it is actually gone.
 *
 * SIGKILL, not SIGTERM, and that is the whole point of these tests. SIGTERM can be
 * caught and cleaned up after; SIGKILL cannot. No handler runs, no LREM happens,
 * no final heartbeat is written — the process simply stops existing, exactly as it
 * would if the machine lost power. Anything that survives this survived without
 * the worker's cooperation.
 */
export async function killWorker(w: SpawnedWorker): Promise<void> {
  if (w.child.exitCode !== null || w.child.signalCode !== null) return;

  await new Promise<void>((done) => {
    w.child.once("exit", () => done());
    w.child.kill("SIGKILL");
  });
}

/** SIGKILL every worker and wait for the processes to actually be gone. */
export async function killWorkers(workers: SpawnedWorker[]): Promise<void> {
  await Promise.all(workers.map(killWorker));
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
