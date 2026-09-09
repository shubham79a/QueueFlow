import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { Semaphore } from "../shared/semaphore.js";
import { startHeartbeat, TTL_S } from "../shared/heartbeat.js";
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

/**
 * Whether a write has to prove it still holds the job's lease. On by default.
 *
 * THIS SWITCH EXISTS TO MAKE A BUG VISIBLE, and for no other reason. The argument
 * for the lease is that a worker declared dead by mistake will otherwise record a
 * result for a job somebody else now owns — and an argument about a race is worth
 * very little next to two rows in a table. Turning fencing off reproduces the
 * duplicate on demand, so the crash test can run the identical scenario both ways
 * and point at the difference.
 *
 * There is no reason to turn it off in normal use.
 */
const FENCING = (process.env.FENCING ?? "on").toLowerCase() !== "off";

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

/**
 * This worker's own processing list. Computed once because it appears in the hot
 * loop, and because a typo here would be the exact silent bug KEYS exists to stop.
 */
const PROCESSING = KEYS.processing(WORKER_ID);

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
            idempotency_key, created_at, started_at, completed_at, next_run_at,
            lease_id
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
   * that is attempted and dies mid-flight has still been attempted, and the retry
   * cap has to count it or a poisonous job retries forever.
   *
   * TWO THINGS WERE ADDED TO THIS STATEMENT, AND BOTH ARE ABOUT THE SAME EVENT:
   * a job can now arrive here that somebody else is already running, because the
   * reaper returns work from a worker it believes is dead and it is sometimes
   * wrong about that.
   *
   *   WHERE status IN ('queued','retrying')
   *     A job in any other state is not up for grabs. 'running' means another
   *     worker holds it; 'succeeded' or 'dead' means it is finished and the id
   *     reaching this worker is just litter. Doing this as part of the UPDATE
   *     rather than as a SELECT beforehand is what makes it safe — two workers
   *     both pass a prior SELECT, but only one UPDATE changes the row, and
   *     Postgres's row locking settles which.
   *
   *   lease_id = gen_random_uuid()
   *     A fresh token, kept below and quoted on every subsequent write about this
   *     job. Claiming REVOKES whatever lease was outstanding, so the previous
   *     holder — if there is one, still running, unaware it has been declared
   *     dead — can no longer record anything.
   */
  const claimed = await query<{ attempts: number; lease_id: string }>(
    db,
    `UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1,
                     lease_id = gen_random_uuid()
      WHERE id = $1 AND status IN ('queued', 'retrying')
      RETURNING attempts, lease_id`,
    [job.id],
  );

  const claim = claimed[0];
  if (!claim) {
    /**
     * Somebody else owns it, or it is already finished. Not an error and not
     * worth retrying: the correct response to "this job is not mine" is to put it
     * down. The caller releases the id from this worker's processing list, and
     * whoever does hold the lease carries on undisturbed.
     */
    log.info(job.id, `not claimable — row says '${job.status}', leaving it alone`);
    return;
  }

  /**
   * Take the new count from RETURNING rather than adding one in JavaScript.
   *
   * The row was SELECTed before this UPDATE, so the in-memory copy is already a
   * version behind — a handler reading job.attempts would report the attempt it
   * was on last time. RETURNING hands back the value the database actually
   * committed, which is what the webhook's X-QueueFlow-Attempt header reports and
   * what the backoff delay is computed from.
   */
  job.attempts = claim.attempts;

  /** This execution's proof of ownership. Every write below has to show it. */
  const lease = claim.lease_id;

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
    let fenced = false;

    try {
      await client.query("BEGIN");

      /**
       * THE FENCE — and note that the status UPDATE now comes FIRST.
       *
       * The order is the point. This statement both settles the job and asks
       * whether this worker is still entitled to settle it, in one operation. If
       * the lease was reissued while the handler ran — the reaper decided this
       * worker was dead and gave the job to somebody else — then `lease_id` no
       * longer matches, the UPDATE touches zero rows, and the effect row below is
       * never written.
       *
       * Doing it the other way round would insert the evidence first and then
       * discover it was not entitled to. Inside a transaction that still rolls
       * back correctly, but it makes the code read as though the check were an
       * afterthought, and it is not: it is the reason any of this is safe.
       *
       * `$3::boolean IS FALSE OR ...` is the FENCING switch, passed as a parameter
       * rather than spliced into the SQL text. Same discipline as everywhere else
       * here — the query string is a constant, and values travel separately.
       */
      const settled = await client.query(
        `UPDATE jobs SET status = 'succeeded', completed_at = now()
          WHERE id = $1 AND ($3::boolean IS FALSE OR lease_id = $2)`,
        [job.id, lease, FENCING],
      );

      if ((settled.rowCount ?? 0) === 0) {
        fenced = true;
        await client.query("ROLLBACK");
      } else {
        await client.query(
          `INSERT INTO job_effects (job_id, worker_id) VALUES ($1, $2)`,
          [job.id, WORKER_ID],
        );
        await client.query("COMMIT");
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      // Always return it to the pool. A leaked client is a connection the pool can
      // never hand out again, and five of those deadlock this worker permanently.
      client.release();
    }

    if (fenced) {
      /**
       * The work finished, and none of it is recorded. That is the correct
       * outcome and it is worth being clear about what it does and does not fix.
       *
       * The RECORD is single: one row in job_effects, written by whoever holds the
       * lease. The WORK was not. If this job posted a webhook, the receiver got it
       * — a second time, before this worker had any way to know it had been
       * replaced. Nothing on this side can reach out and undo that.
       *
       * That is the honest shape of the guarantee: at-least-once delivery, plus a
       * consumer that recognises a repeat, which together produce an
       * exactly-once EFFECT. Exactly-once delivery was never on the table.
       */
      log.error(
        job.id,
        `fenced out — finished the work, but the lease was reissued while it ran.` +
          ` Another worker owns this job now, so nothing was recorded.`,
      );
      return;
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
      const buried = await query<{ id: string }>(
        db,
        `UPDATE jobs SET status = 'dead', last_error = $2, completed_at = now(),
                         next_run_at = NULL
          WHERE id = $1 AND ($4::boolean IS FALSE OR lease_id = $3)
          RETURNING id`,
        [job.id, message, lease, FENCING],
      );

      if (buried.length === 0) {
        log.error(job.id, `fenced out while failing — another worker owns this job now`);
        return;
      }

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
    const parked = await query<{ id: string }>(
      db,
      `UPDATE jobs SET status = 'retrying', last_error = $2, next_run_at = $3
        WHERE id = $1 AND ($5::boolean IS FALSE OR lease_id = $4)
        RETURNING id`,
      [job.id, message, runAt, lease, FENCING],
    );

    /**
     * FENCED, AND THIS IS THE BRANCH THAT MATTERS MOST.
     *
     * Without the check above, a worker that had been declared dead and whose
     * handler then failed would happily ZADD the job into the delayed set — while
     * another worker was in the middle of running it successfully. The scheduler
     * would promote it when the backoff elapsed and the job would run a THIRD
     * time, scheduled by a process that had no right to speak for it.
     *
     * Returning before the ZADD is what stops a stale worker injecting phantom
     * retries into a job somebody else is handling.
     */
    if (parked.length === 0) {
      log.error(
        job.id,
        `fenced out while failing — no retry scheduled, another worker owns this job now`,
      );
      return;
    }

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

/**
 * Return anything this worker was still holding when it last stopped.
 *
 * A restart is the common case of a dead worker, and it is the one case where the
 * jobs can come back INSTANTLY instead of waiting out a heartbeat expiry plus a
 * reap cycle. The process that lost them is the process best placed to notice.
 *
 * THE GUARD IS NOT PARANOIA. Two processes started with the same WORKER_ID share
 * this processing list, and without the check the second one would boot and
 * cheerfully hand every job the FIRST one is actively running back to the queue —
 * turning a config mistake into silent duplicate execution across the fleet. If
 * the alive key is still there, somebody is using this id, and the honest response
 * is to say so and touch nothing. The reaper handles genuinely dead workers, so
 * skipping here costs a delay, not a job.
 *
 * BUT IT CANNOT SIMPLY GIVE UP EITHER, and that took a bug to notice. A worker
 * restarted QUICKLY — the ordinary case, a crash loop or a redeploy — finds its
 * own heartbeat from the process that just died, still ticking down. Skipping
 * recovery there and then writing a fresh heartbeat would be the worst of both
 * worlds: the jobs are never recovered by this process, and the new heartbeat
 * makes this worker look alive to the reaper, so they are never recovered by
 * anything else. They would sit in that list until someone noticed by hand.
 *
 * So: wait for the key to lapse, and bound the wait. A stale key belonging to a
 * dead process expires within its own TTL. A key that is still there afterwards is
 * being actively refreshed, which means a genuinely different process is using
 * this WORKER_ID — a configuration error, and the safe answer is to touch nothing
 * and say so loudly.
 */
async function recoverOwnProcessing(): Promise<void> {
  const aliveKey = KEYS.alive(WORKER_ID);

  // Slightly longer than a full TTL, so a key written a moment before the previous
  // process died has time to expire on its own.
  const waitMs = TTL_S * 1000 + 1_000;
  const deadline = Date.now() + waitMs;

  if (await scheduling.exists(aliveKey)) {
    log.info(null, `a heartbeat already exists for ${WORKER_ID}; waiting up to ${waitMs}ms for it`);

    while (Date.now() < deadline && (await scheduling.exists(aliveKey))) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (await scheduling.exists(aliveKey)) {
    log.error(
      null,
      `another process is alive as ${WORKER_ID} — leaving ${PROCESSING} alone.` +
        ` WORKER_ID must be unique per process.`,
    );
    return;
  }

  const stranded = (await scheduling.lrange(PROCESSING, 0, -1)).filter(isUuid);
  if (stranded.length === 0) return;

  /**
   * Rows first, then the list — the same ordering as everywhere else in this
   * project, for the same reason. These rows still say 'running' from the claim
   * the dead process made; put them back to 'queued' before the ids become
   * takeable, so no worker can ever pick up an id whose row still claims someone
   * else is on it.
   *
   * started_at is cleared because the job is going back to waiting and that column
   * measures queue wait. Leaving the old value would report the crash as part of
   * the execution time. attempts is NOT reset: that attempt really was spent, and
   * the retry cap has to count it or a job that kills its worker every time would
   * be requeued forever.
   */
  await query(
    db,
    `UPDATE jobs SET status = 'queued', started_at = NULL
      WHERE id = ANY($1::uuid[]) AND status = 'running'`,
    [stranded],
  );

  // Tail to tail: taken from the oldest end of the processing list and pushed onto
  // the end of pending that BLMOVE reads from, so a recovered job is served NEXT.
  // It has been waiting longer than anything else in the queue.
  let moved = 0;
  while ((await scheduling.lmove(PROCESSING, KEYS.pending, "RIGHT", "RIGHT")) !== null) {
    moved += 1;
  }

  log.info(null, `recovered ${moved} job(s) stranded by a previous run of ${WORKER_ID}`);
}

async function main(): Promise<void> {
  /**
   * THIS ORDER IS LOAD-BEARING.
   *
   *   1. recover — must run while no alive key exists, since the absence of that
   *      key is exactly what proves no other process owns this WORKER_ID.
   *   2. heartbeat — must land BEFORE the first job is taken. A worker holding a
   *      job while looking dead is a worker the reaper will rob.
   *   3. take work.
   *
   * Swap the first two and a restarting worker would refuse to recover its own
   * stranded jobs, because it would find its own heartbeat and conclude a rival
   * was using its name.
   */
  await recoverOwnProcessing();
  await startHeartbeat(scheduling, WORKER_ID, log);

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
     * BLMOVE — Blocking List MOVE — rather than polling, and rather than BRPOP.
     *
     * Two separate ideas are stacked into this one command, added in different
     * phases for different reasons.
     *
     * THE BLOCKING HALF, unchanged since the first version of this loop. Polling
     * forces a choice between two bad options. Poll every 100ms and you send
     * 864,000 pointless round-trips a day to be told "nothing", each one burning a
     * little CPU on both ends. Poll every 5s to avoid that and you have added up to
     * 5 seconds of latency to a job that was ready immediately. Blocking removes
     * the trade-off: Redis parks the connection and answers the instant something
     * is pushed. Zero commands while idle, zero added latency.
     *
     * THE MOVE HALF, which is what changed. BRPOP used to REMOVE the id — the
     * moment it crossed the socket Redis had forgotten the job existed, and a
     * worker killed one millisecond later took the only copy with it. All that
     * survived was a Postgres row stuck at 'running' that nothing would ever move
     * again (GAP-2.2), multiplied by CONCURRENCY once one process could hold many
     * jobs at once (GAP-3.4).
     *
     * BLMOVE pops from `pending` and pushes onto this worker's processing list as
     * ONE atomic operation. There is no instant in between: the id is in `pending`,
     * or it is in `queueflow:processing:w1` — never in neither, never in both.
     * `kill -9` this process right now and the id is still in Redis, on a key with
     * this worker's name in it, waiting to be found.
     *
     * "RIGHT", "LEFT" say where to take from and where to put: take from pending's
     * tail, the same end BRPOP used so FIFO order is unchanged, and push onto the
     * head of the processing list. The trailing `0` is the timeout in seconds, and
     * 0 means "never time out".
     *
     * WHAT THIS DOES NOT DO YET. Nothing puts the job back. The id will sit in that
     * processing list indefinitely unless something notices the owner is gone —
     * which is the heartbeat and the reaper. This step only makes the job
     * SURVIVABLE. Recovering it is the next one.
     */
    const jobId = await blocking.blmove(KEYS.pending, PROCESSING, "RIGHT", "LEFT", 0);

    if (jobId === null) {
      slots.release(); // nothing taken, so give the slot straight back
      continue; // only on timeout, which cannot happen with 0.
    }

    // What came off the socket is a string. Postgres would reject a malformed uuid
    // with a type error anyway, but failing here says something useful about where
    // the bad value came from.
    if (!isUuid(jobId)) {
      log.error(null, `discarded non-uuid queue entry: ${jobId.slice(0, 80)}`);

      // It is sitting in this worker's processing list now, and it is junk. Drop it
      // from there too, or the reaper will faithfully rescue it back into pending
      // for the rest of time.
      await scheduling.lrem(PROCESSING, 1, jobId);

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
     * WHICH BRANCH RUNS IS THE RELEASE PROTOCOL, and it is the counterpart to the
     * BLMOVE above. The id stays in the processing list for exactly as long as this
     * worker is still responsible for the job:
     *
     *   resolved — processOne reached a terminal state AND recorded it: succeeded,
     *              dead, parked for a retry, or a missing row it logged and gave up
     *              on. Postgres now holds the outcome, so the id has no further
     *              claim on anybody, and LREM releases it.
     *
     *   rejected — something failed at a point where the outcome could NOT be
     *              recorded — Postgres unreachable, most likely. DELIBERATELY NO
     *              LREM. The id stays in the processing list, and once this worker
     *              stops heartbeating the reaper will return it to pending and it
     *              will run again.
     *
     * That asymmetry is a choice, and it is the same one the whole project keeps
     * making: losing a job is unrecoverable, running one twice is merely something
     * to be idempotent about. When in doubt, hold on to it.
     *
     * `void` marks the floating promise as deliberate. `.finally` returns the slot
     * on every path — a slot leaked here would shrink this worker's capacity
     * permanently and silently until it stopped taking work altogether.
     */
    void processOne(jobId)
      .then(() => scheduling.lrem(PROCESSING, 1, jobId))
      .catch((err: unknown) =>
        log.error(
          jobId,
          `left in ${PROCESSING} for the reaper — no outcome could be recorded: ` +
            (err instanceof Error ? err.message : String(err)),
        ),
      )
      .finally(() => slots.release());
  }
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
