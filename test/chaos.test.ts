import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  closeConnections,
  db,
  effectStats,
  enqueue,
  killWorker,
  killWorkers,
  pendingList,
  reset,
  spawnScheduler,
  spawnWorker,
  waitFor,
  type SpawnedWorker,
} from "./helpers.js";

/**
 * Keep killing workers while work is flowing, then check the books.
 *
 * Every other test in this project sets up one specific situation and asserts one
 * specific thing about it. This one does the opposite: it makes no attempt to
 * predict what will happen. Jobs are enqueued continuously, processes are killed
 * at moments nobody chose, and the only claims made at the end are the two that
 * have to hold no matter what happened in between:
 *
 *   NOTHING WAS LOST       every job reached a terminal state
 *   NOTHING RAN TWICE      every job has exactly one row in job_effects
 *
 * Those are checked against the proof table rather than against logs, because a
 * log can only show what a process believed. A count of side effects is what
 * actually happened.
 *
 * Each replacement worker gets a NEW id rather than reusing the dead one's. That
 * is how a real fleet behaves — a container that dies comes back with a different
 * name — and it means every rescue here goes through the reaper rather than
 * through a worker recovering its own list, which the crash tests cover separately.
 */
const ROUNDS = 8;
const PER_ROUND = 40;
const FLEET = 3;
const CONCURRENCY = 5;

/** Dies fast enough for a test to be worth running, refreshes fast enough to stay alive. */
const WORKER_ENV = {
  CONCURRENCY: String(CONCURRENCY),
  HEARTBEAT_TTL_S: "2",
  HEARTBEAT_INTERVAL_MS: "300",
};

async function statusCounts(): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; n: string }>(
    "SELECT status, COUNT(*)::text AS n FROM jobs GROUP BY status",
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

describe("chaos", () => {
  let procs: SpawnedWorker[] = [];

  beforeAll(async () => {
    await reset();
  });

  afterAll(async () => {
    await killWorkers(procs);
    await closeConnections();
  });

  test("nothing is lost and nothing runs twice while workers are killed at random", async () => {
    const scheduler = await spawnScheduler({ REAP_INTERVAL_MS: "250" });
    procs.push(scheduler);

    let spawned = 0;
    const freshWorker = async () => {
      const w = await spawnWorker(`c${++spawned}`, WORKER_ENV);
      procs.push(w);
      return w;
    };

    const fleet = await Promise.all(Array.from({ length: FLEET }, freshWorker));
    const ids: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      ids.push(...(await enqueue(PER_ROUND, "sleep", { ms: 20 })));

      // Kill at an arbitrary point in the round, so the victim is sometimes idle,
      // sometimes mid-job, and sometimes holding a full set of concurrent jobs.
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));

      const victim = Math.floor(Math.random() * fleet.length);
      await killWorker(fleet[victim]!);
      fleet[victim] = await freshWorker();
    }

    /**
     * Everything settles. The timeout is generous because a job stranded by the
     * last kill cannot come back until its worker's heartbeat has expired and the
     * reaper has run — recovery is bounded by the TTL, not by how fast the queue
     * moves.
     */
    await waitFor(
      async () => {
        const counts = await statusCounts();
        const done = (counts.succeeded ?? 0) + (counts.dead ?? 0) + (counts.failed ?? 0);
        return done >= ids.length;
      },
      180_000,
      `all ${ids.length} jobs to settle`,
    );

    const counts = await statusCounts();
    const stats = await effectStats();

    // NOTHING LOST. Not one job left sitting at 'running' because the process
    // holding it stopped existing, and not one abandoned in a processing list.
    expect(counts.succeeded ?? 0).toBe(ids.length);
    expect(counts.running ?? 0).toBe(0);
    expect(counts.queued ?? 0).toBe(0);

    // NOTHING RAN TWICE. Jobs were genuinely claimed more than once — the reaper
    // handed plenty of them to a second worker — but only the lease holder was
    // ever allowed to record a result.
    expect(stats.duplicates).toBe(0);
    expect(stats.total).toBe(ids.length);

    // Redis is empty too: no leftover ids in the queue, and every processing list
    // emptied out (Redis drops a list key once its last element is gone).
    expect(await pendingList()).toHaveLength(0);

    // And the work really was spread across the fleet, including workers that
    // replaced killed ones — otherwise this could have passed with one survivor
    // quietly doing everything.
    expect(stats.distinctWorkers).toBeGreaterThan(FLEET);
  });
});
