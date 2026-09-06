import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { Semaphore } from "../shared/semaphore.js";
import { nextDelayMs } from "../shared/retry.js";
import { isUuid, rowToJob, type JobRow } from "../shared/types.js";
import { handlers } from "./handlers.js";

const WORKER_ID = process.env.WORKER_ID ?? "w1";

/**
 * How many jobs this ONE process may have in flight at once.
 *
 * This is a different dial from "how many worker processes are running", and the
 * difference is not cosmetic:
 *
 *   CONCURRENCY   helps only for IO-BOUND work. `sleep` is a timer and
 *                 `deliver_webhook` is a socket wait — during both, the event
 *                 loop is idle and can service other jobs. One process genuinely
 *                 runs many at once.
 *
 *   MORE WORKERS  is what CPU-BOUND work needs. Resizing an image or hashing a
 *                 password occupies the event loop, so a second job in the same
 *                 process waits for the first regardless of this setting. Only
 *                 another process (another core) helps.
 *
 * Default 1, so behaviour is unchanged unless asked for.
 */
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));

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
 * The second connection, and the reason createRedis has always been a factory.
 *
 * This is the constraint described above actually biting. When a handler fails,
 * the worker must ZADD the job into the delayed set — but `blocking` is parked on
 * BRPOP waiting for the next job, and a parked connection cannot carry another
 * command. The ZADD would sit in ioredis's queue until a job happened to arrive,
 * which could be never on an idle queue: the retry would simply not be scheduled.
 *
 * So: one connection blocks, one works. Phase 5's heartbeat will use this one too,
 * for exactly the same reason.
 */
const scheduling = createRedis(`${WORKER_ID}:scheduling`, log);

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
            idempotency_key, created_at, started_at, completed_at, next_run_at
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
     * FAILURE — retry, or give up.
     *
     * The job has already been attempted `job.attempts` times (the claim above
     * incremented it). If it has attempts left it is parked for a backoff; if not
     * it becomes dead and waits in the dead-letter queue for a human.
     */
    const message = err instanceof Error ? err.message : String(err);

    if (job.attempts >= job.maxAttempts) {
      /**
       * Out of attempts. 'dead' is terminal, and the dead-letter queue is simply
       * `WHERE status = 'dead'` — no separate Redis list, because a second copy of
       * this fact could disagree with the row that has the error and the timings.
       *
       * A DLQ is an inbox, not a graveyard: someone reads it, fixes the cause, and
       * replays. That is what POST /jobs/:id/replay is for.
       */
      await query(
        db,
        `UPDATE jobs SET status = 'dead', last_error = $2, completed_at = now(),
                         next_run_at = NULL
          WHERE id = $1`,
        [job.id, message],
      );

      log.error(job.id, `dead after ${job.attempts} attempts: ${message}`);
      return;
    }

    const delayMs = nextDelayMs(job.attempts);
    const runAt = new Date(Date.now() + delayMs);

    /**
     * Row first, then the sorted set — the same ordering as the API's insert-then-
     * enqueue, for the same reason. A crash between the two leaves a 'retrying' row
     * with a next_run_at that a query can find. Reversed, it would leave a
     * scheduled id whose row still says 'running', and nothing would reconcile it.
     */
    await query(
      db,
      `UPDATE jobs SET status = 'retrying', last_error = $2, next_run_at = $3
        WHERE id = $1`,
      [job.id, message, runAt],
    );

    /**
     * ZADD, not sleep().
     *
     * Sleeping here would hold this worker's slot for the whole backoff — sixteen
     * seconds of capacity spent waiting — and a worker killed during that sleep
     * would take the retry with it. Parking the job in Redis returns the slot
     * immediately, survives this process entirely, and lets ANY worker run the job
     * once the scheduler promotes it.
     *
     * The score is the epoch-ms it becomes due, which is what makes
     * ZRANGEBYSCORE 0 <now> the whole of "what is due?".
     */
    await scheduling.zadd(KEYS.delayed, runAt.getTime(), job.id);

    log.error(
      job.id,
      `attempt ${job.attempts}/${job.maxAttempts} failed: ${message}` +
        ` — retry in ${(delayMs / 1000).toFixed(1)}s`,
    );
  }
}

/**
 * The capacity limit, and the reason the loop below is shaped the way it is.
 *
 * NOTHING IN HERE IS A LOCK, and none is needed.
 *
 * Three workers all block on the same list. Redis executes commands one at a
 * time — it is single-threaded — so three simultaneous BRPOPs are serialised by
 * the server, and an element is handed to exactly one of them. Two workers
 * cannot receive the same job id.
 *
 * That is mutual exclusion obtained from the data store rather than built on top
 * of it. Adding a lock here would be pure ceremony: it would guard a race that
 * the server has already made impossible, while adding a way to deadlock.
 */
const slots = new Semaphore(CONCURRENCY);

async function main(): Promise<void> {
  log.info(null, `worker ${WORKER_ID} up, concurrency ${CONCURRENCY}, waiting on ${KEYS.pending}`);

  while (true) {
    /**
     * ACQUIRE A SLOT BEFORE POPPING. This ordering is the substance of the phase.
     *
     * The tempting alternative is to pop eagerly and buffer the jobs in memory.
     * That is wrong, and not subtly:
     *
     *   - The queue would move INTO this process. `llen queueflow:pending` would
     *     report empty while twenty jobs sat in a local array.
     *   - A crash would strand twenty jobs instead of one.
     *   - Those buffered jobs would be invisible to every other worker, so an
     *     idle worker could sit doing nothing beside a backlog.
     *
     * Waiting for a slot first means a job leaves Redis only when something is
     * ready to run it immediately. Work this process cannot start stays in Redis,
     * visible and available to anyone. That is backpressure: consumer capacity,
     * not producer rate, decides when work is taken.
     */
    await slots.acquire();
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

    if (!result) {
      slots.release(); // nothing taken, so give the slot straight back
      continue; // only on timeout, which cannot happen with 0.
    }

    const [, jobId] = result;

    // What came off the socket is a string. Postgres would reject a malformed uuid
    // with a type error anyway, but failing here says something useful about where
    // the bad value came from.
    if (!isUuid(jobId)) {
      log.error(null, `discarded non-uuid queue entry: ${jobId.slice(0, 80)}`);
      slots.release();
      continue;
    }

    /**
     * NOT awaited — and that is the change that lifts the ceiling.
     *
     * Previously this line was `await processOne(jobId)`, so the loop could not
     * reach BRPOP again until the handler finished. One job at a time, always:
     * five 8-second jobs took 40 seconds on an idle machine.
     *
     * Now the await is on the SLOT, not on the job. The loop comes straight back
     * around and blocks on the next BRPOP while this job runs, so up to
     * CONCURRENCY jobs are in flight and the limit is capacity rather than
     * sequence.
     *
     * `void` marks the floating promise as deliberate. `.finally` returns the slot
     * on success AND on failure — processOne already swallows handler errors, but
     * if it ever threw for another reason, a slot leaked here would shrink this
     * worker's capacity permanently and silently until it stopped taking work
     * altogether.
     */
    void processOne(jobId).finally(() => slots.release());
  }
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
