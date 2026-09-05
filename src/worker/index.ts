import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { isUuid, rowToJob, type JobRow } from "../shared/types.js";
import { handlers } from "./handlers.js";

const WORKER_ID = process.env.WORKER_ID ?? "w1";

const log = createLogger(WORKER_ID);

/**
 * This connection exists to do one thing: block on the queue.
 *
 * BRPOP does not return until a job arrives, and while it is outstanding the
 * connection is parked server-side and cannot carry another command. Anything else
 * this process wants to ask Redis — a heartbeat SET, an LLEN, a metrics read —
 * would sit behind the blocked call and not run until a job happened to arrive,
 * which is the opposite of what a heartbeat is for.
 *
 * So: one connection for blocking, a second for everything else. Phase 5 is where
 * the second one earns its keep (heartbeats).
 */
const blocking = createRedis(`${WORKER_ID}:blocking`, log);

/**
 * Postgres gets a pool rather than a single connection, because nothing here parks
 * a connection indefinitely the way BRPOP does — see the comment in shared/db.ts.
 */
const db = createDb(WORKER_ID, log);

async function processOne(jobId: string): Promise<void> {
  /**
   * Redis handed over an id. The job itself has to be fetched, because Redis no
   * longer carries it — that split is the substance of this phase.
   *
   * It also means the worker can be handed an id whose row does not exist. That is
   * not hypothetical: it is exactly what the reversed write order in the API would
   * produce. Log it and move on rather than crashing, because a worker that dies
   * on one bad message is a worker that one bad message can take down.
   */
  const rows = await query<JobRow>(
    db,
    `SELECT id, type, payload, status, attempts, max_attempts, last_error,
            idempotency_key, created_at, started_at, completed_at
       FROM jobs WHERE id = $1`,
    [jobId],
  );

  const row = rows[0];
  if (!row) {
    log.error(jobId, "no such job row — id was queued but never recorded");
    return;
  }

  const job = rowToJob(row);

  /**
   * Claim it. This is the transition the API cannot make and the reason the row
   * has three timestamps: started_at - created_at is queue wait (a property of
   * this system), completed_at - started_at is execution time (a property of the
   * work). Measuring them together is the standard benchmarking mistake.
   *
   * attempts increments here, at the START of an execution, not at the end. A job
   * that is attempted and dies mid-flight has still been attempted, and Phase 4's
   * retry cap has to count it or a poisonous job retries forever.
   */
  const claimed = await query<{ attempts: number }>(
    db,
    `UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = $1
      RETURNING attempts`,
    [job.id],
  );

  /**
   * Take the new count from RETURNING rather than adding one in JavaScript.
   *
   * The row was SELECTed before this UPDATE, so the in-memory copy is already a
   * version behind — a handler reading job.attempts would report the attempt it
   * was on last time. RETURNING hands back the value the database actually
   * committed, which is what the webhook's X-QueueFlow-Attempt header reports and
   * what Phase 4's backoff delay will be computed from.
   */
  job.attempts = claimed[0]?.attempts ?? job.attempts + 1;

  try {
    await handlers[job.type](job, log);

    /**
     * SUCCESS — and the two writes below are one transaction on purpose.
     *
     * job_effects is the evidence that the correctness queries read. If the effect
     * row committed and the status update did not, the proof would describe a job
     * that ran but never finished; if the status committed and the effect did not,
     * the "did anything claim success without running?" query would report a
     * phantom. Either way the instrument would be lying about the thing it exists
     * to measure, so both land or neither does.
     *
     * BEGIN/COMMIT must run on ONE connection, which is why this takes a client
     * out of the pool by hand instead of using the query() helper. Issuing BEGIN
     * through a pool would start a transaction on whichever connection happened to
     * be free, and the following statements could land on different ones.
     */
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO job_effects (job_id, worker_id) VALUES ($1, $2)`,
        [job.id, WORKER_ID],
      );
      await client.query(
        `UPDATE jobs SET status = 'succeeded', completed_at = now() WHERE id = $1`,
        [job.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      // Always return it to the pool. A leaked client is a connection the pool can
      // never hand out again, and five of those deadlock this worker permanently.
      client.release();
    }

    log.info(job.id, "succeeded");
  } catch (err) {
    /**
     * FAILURE — terminal, for now.
     *
     * There is no retry, no backoff and no dead-letter queue: the error is recorded
     * and the job stops here. That is GAP-2.3, and it closes in Phase 4.
     *
     * What is different from Phase 1 is that the failure is no longer invisible.
     * The row says failed, last_error says why, and attempts says how many times it
     * was tried. In Phase 1 this information existed only in a terminal.
     */
    const message = err instanceof Error ? err.message : String(err);

    await query(
      db,
      `UPDATE jobs SET status = 'failed', last_error = $2, completed_at = now()
        WHERE id = $1`,
      [job.id, message],
    );

    log.error(job.id, `failed: ${message}`);
  }
}

async function main(): Promise<void> {
  log.info(null, `worker ${WORKER_ID} up, waiting on ${KEYS.pending}`);

  while (true) {
    /**
     * BRPOP — Blocking Right POP — rather than polling with LPOP in a loop.
     *
     * Polling forces a choice between two bad options. Poll every 100ms and you
     * send 864,000 pointless round-trips a day to be told "nothing", each one
     * burning a little CPU on both ends. Poll every 5s to avoid that and you have
     * added up to 5 seconds of latency to a job that was ready immediately.
     * Blocking removes the trade-off: Redis parks the connection and answers the
     * instant something is pushed. Zero commands while idle, zero added latency.
     *
     * The `0` is the timeout in seconds, and 0 means "never time out". The return
     * shape is [key, value] — the key comes back because BRPOP can watch several
     * lists at once and you would otherwise not know which one fired.
     *
     * WHAT THIS PHASE DID AND DID NOT FIX:
     *
     * BRPOP still REMOVES the id. The instant this returns, Redis has forgotten
     * this job exists. What changed is that Postgres has not — so a worker killed
     * mid-job now leaves a row stuck at 'running' with a started_at and no
     * completed_at, instead of leaving nothing at all.
     *
     * The job is still lost. It is merely visible now, which is the whole of what
     * Phase 2 claims. Phase 5 replaces this line with BLMOVE, which pops and pushes
     * to a per-worker processing list in one atomic step, so the id survives the
     * crash and a reaper can requeue it. That stuck 'running' row is GAP-2.2, and
     * it is exactly what the reaper will hunt for.
     */
    const result = await blocking.brpop(KEYS.pending, 0);

    if (!result) continue; // only on timeout, which cannot happen with 0.

    const [, jobId] = result;

    // What came off the socket is a string. Postgres would reject a malformed uuid
    // with a type error anyway, but failing here says something useful about where
    // the bad value came from.
    if (!isUuid(jobId)) {
      log.error(null, `discarded non-uuid queue entry: ${jobId.slice(0, 80)}`);
      continue;
    }

    /**
     * Awaited, not fired-and-forgotten. This worker runs exactly one job at a time:
     * the loop cannot come back around to BRPOP until processOne resolves.
     *
     * That is a real ceiling — a 5-second job means at most 12 jobs a minute out of
     * this process no matter how many are waiting — and it is intentional. Making
     * it faster is Phase 3.
     */
    await processOne(jobId);
  }
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
