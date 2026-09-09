import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  aliveTtl,
  closeConnections,
  effectsFor,
  enqueue,
  jobRow,
  killWorker,
  killWorkers,
  pendingList,
  processingList,
  reset,
  spawnReceiver,
  spawnScheduler,
  spawnWorker,
  waitFor,
  type SpawnedWorker,
} from "./helpers.js";

/**
 * What happens when a worker stops existing.
 *
 * Every test here SIGKILLs a real process holding a real job. SIGKILL, not
 * SIGTERM, because SIGTERM can be caught: a handler could run, flush state, tidy
 * up. SIGKILL runs nothing. No LREM, no final heartbeat, no chance to record
 * anything — the process simply ceases, exactly as it would on power loss. Every
 * recovery below therefore happened WITHOUT the dead worker's cooperation, which
 * is the only kind of recovery worth having.
 *
 * The last two tests are the important ones. They run the same scenario twice,
 * with the lease check on and off, so that the duplicate this system is designed
 * around can be SEEN rather than argued about.
 */

/** Dies quickly enough for a test, refreshes often enough to stay alive while running. */
const HEALTHY = { HEARTBEAT_TTL_S: "2", HEARTBEAT_INTERVAL_MS: "400" };

/** Look for dead workers four times a second instead of every five seconds. */
const FAST_REAP = { REAP_INTERVAL_MS: "250" };

const RECEIVER_PORT = 4102;

const rowOf = async (id: string) => (await jobRow(id))!;

/**
 * Wait until a worker is genuinely running a job, not merely holding its id.
 *
 * Those are two different instants and the gap between them matters. BLMOVE puts
 * the id in the processing list first; the claim that sets the row to 'running'
 * lands a moment later. A test that killed a worker in between would be testing
 * the pre-claim window rather than the mid-job crash it means to test.
 */
const claimedBy = (id: string, workerId: string) =>
  waitFor(
    async () => (await rowOf(id)).status === "running" && (await processingList(workerId)).includes(id),
    15_000,
    `${workerId} to claim the job`,
  );

const reached = (id: string, status: string, ms = 40_000) =>
  waitFor(async () => (await rowOf(id)).status === status, ms, `job ${id.slice(0, 8)} to be ${status}`);

describe("surviving a dead worker", () => {
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

  test("a killed worker leaves its job visible, and the reaper puts it back", async () => {
    const w1 = await spawnWorker("w1", HEALTHY);
    procs.push(w1);

    const [id] = await enqueue(1, "sleep", { ms: 3000 });
    await claimedBy(id!, "w1");

    await killWorker(w1);

    /**
     * THE ASSERTION THIS WHOLE PHASE EXISTS FOR.
     *
     * The process is gone. It ran no cleanup code — it could not, it was SIGKILLed
     * mid-sleep. And the job id is still sitting in Redis, on a key naming the
     * worker that was holding it.
     *
     * Before reliable handoff this same kill left NOTHING: BRPOP had already
     * removed the id, so the only trace was a row stuck at 'running' that nothing
     * in the system would ever look at again. Compare the two lines below — one
     * says the job is findable, the other says it is unfinished. Previously only
     * the second was true, and a job that is unfinished and unfindable is lost.
     */
    expect(await processingList("w1")).toContain(id!);
    expect((await rowOf(id!)).status).toBe("running");

    // Nothing has rescued it yet, and nothing will until something notices w1 is
    // not answering. That noticing is the heartbeat expiring.
    expect(await pendingList()).not.toContain(id!);

    const scheduler = await spawnScheduler(FAST_REAP);
    const w2 = await spawnWorker("w2", HEALTHY);
    procs.push(scheduler, w2);

    await reached(id!, "succeeded");

    // The processing list is empty again, and the job ran exactly once despite
    // having been claimed twice.
    expect(await processingList("w1")).toHaveLength(0);
    expect(await effectsFor(id!)).toBe(1);

    // Two claims, though — the attempt lost with w1 still counts, which is what
    // stops a job that kills its worker every time from being retried forever.
    expect((await rowOf(id!)).attempts).toBe(2);
  });

  test("a restarted worker recovers its own jobs without waiting for the reaper", async () => {
    const w1 = await spawnWorker("w1", HEALTHY);
    procs.push(w1);

    const [id] = await enqueue(1, "sleep", { ms: 2000 });
    await claimedBy(id!, "w1");

    await killWorker(w1);

    // The dead worker's heartbeat has NOT expired yet — this is a fast restart,
    // the ordinary case after a crash or a redeploy.
    expect(await aliveTtl("w1")).toBeGreaterThan(0);

    // NO SCHEDULER IS RUNNING. Nothing else in the system is capable of moving
    // this job, so if it completes, the restarted worker recovered it itself.
    const again = await spawnWorker("w1", HEALTHY);
    procs.push(again);

    await reached(id!, "succeeded");
    expect(await effectsFor(id!)).toBe(1);

    /**
     * It waited for the old heartbeat before touching the list, rather than
     * assuming the name was free. That wait is what keeps two processes sharing a
     * WORKER_ID from stealing each other's in-flight work — and skipping it
     * outright would be worse than either: the restarted worker would write a
     * fresh heartbeat, and the reaper would then never see these jobs as
     * abandoned at all.
     */
    expect(again.output.join("")).toContain("waiting up to");
    expect(again.output.join("")).toContain("recovered 1 job");
  });

  /**
   * Take a job away from a worker that is alive and well.
   *
   * The worker is given a heartbeat that expires after one second and is only
   * refreshed every sixty, so it stops proving it is alive while remaining
   * completely healthy — a stand-in for a long garbage-collection pause or a
   * machine that was briefly starved of CPU. The reaper cannot tell the difference,
   * which is the entire point: no detector can.
   *
   * @returns the job id, once both workers have finished their copy of it.
   */
  async function stealJobFrom(
    fencing: "on" | "off",
    job: { type: "sleep" | "deliver_webhook"; payload: unknown },
  ): Promise<string> {
    const stale = { HEARTBEAT_TTL_S: "1", HEARTBEAT_INTERVAL_MS: "60000", FENCING: fencing };
    const healthy = { HEARTBEAT_TTL_S: "30", HEARTBEAT_INTERVAL_MS: "500", FENCING: fencing };

    const w1 = await spawnWorker("w1", stale);
    procs.push(w1);

    const [id] = await enqueue(1, job.type, job.payload);
    await claimedBy(id!, "w1");

    // w1 is still running the job at this point. It has simply gone quiet.
    await waitFor(async () => (await aliveTtl("w1")) === -2, 15_000, "w1's heartbeat to lapse");

    // Started only now, so that w2 is the only worker free to accept the rescue.
    // w1's single slot is occupied by the job it is still running.
    const scheduler = await spawnScheduler(FAST_REAP);
    const w2 = await spawnWorker("w2", healthy);
    procs.push(scheduler, w2);

    await waitFor(
      async () => (await processingList("w2")).includes(id!),
      25_000,
      "the reaper to hand the job to w2",
    );

    // Both workers are now running the same job. Wait for each to reach its own
    // conclusion — one of them will have recorded a result, the other may have
    // been told it no longer owns the job.
    const finished = /succeeded|fenced out/;
    await waitFor(() => finished.test(w1.output.join("")), 40_000, "w1 to finish its copy");
    await waitFor(() => finished.test(w2.output.join("")), 40_000, "w2 to finish its copy");

    return id!;
  }

  test("without the lease, one job produces two results", async () => {
    const id = await stealJobFrom("off", { type: "sleep", payload: { ms: 4000 } });

    /**
     * THE BUG, ON PURPOSE.
     *
     * Two workers ran the same job and both were allowed to record it, so the
     * proof table now says a job ran twice — because it did. Nothing here is a
     * race that better locking would have prevented: each worker held the job
     * legitimately, one after the other, and the mistake was the decision to move
     * it, which no amount of locking can undo.
     */
    expect(await effectsFor(id)).toBeGreaterThan(1);
  });

  test("with the lease, the same collision produces one result", async () => {
    const id = await stealJobFrom("on", { type: "sleep", payload: { ms: 4000 } });

    // Identical scenario, identical collision, one row. The worker that lost the
    // lease discovered it at commit time and wrote nothing.
    expect(await effectsFor(id)).toBe(1);
    expect((await rowOf(id)).status).toBe("succeeded");

    const loser = procs.find((p) => p.id === "w1")!;
    expect(loser.output.join("")).toContain("fenced out");
  });

  test("the lease cannot un-send a webhook — only the receiver can absorb it", async () => {
    const receiver = await spawnReceiver(RECEIVER_PORT);
    procs.push(receiver);

    const id = await stealJobFrom("on", {
      type: "deliver_webhook",
      payload: {
        url: `http://127.0.0.1:${RECEIVER_PORT}/hook/idempotent?delayMs=4000`,
        timeoutMs: 20_000,
      },
    });

    const seen = (await (await fetch(`http://127.0.0.1:${RECEIVER_PORT}/deliveries`)).json()) as {
      total: number;
      applied: number;
    };

    /**
     * THE HONEST LIMIT OF EVERYTHING IN THIS PROJECT, in three numbers.
     *
     *   effects  1  — the queue's record is single. The lease did its job.
     *   total    2  — the outside world was contacted TWICE. By the time the
     *                 second worker took over, the first request had already been
     *                 sent; there is no mechanism anywhere that could recall it.
     *   applied  1  — and it did not matter, because the receiver recognised the
     *                 job id it had already handled and changed nothing.
     *
     * Which is the whole sentence: exactly-once delivery is impossible, and
     * at-least-once delivery plus an idempotent consumer produces an exactly-once
     * EFFECT. The middle number is the part a queue cannot fix by itself.
     */
    expect(await effectsFor(id)).toBe(1);
    expect(seen.total).toBe(2);
    expect(seen.applied).toBe(1);
  });
});
