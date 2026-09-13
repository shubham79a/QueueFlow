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


// How many jobs this ONE process may have in flight at once.
// This is a different dial from "how many worker processes are running", and the difference is not cosmetic:
//   CONCURRENCY   helps only for IO-BOUND work. IO-BOUND tasks means which are done by external services, like a
//   (EVENT LOOP)  webhook or a database query or redis. While one job is waiting for the external service to respond
//                 another job can be started in the same process, so a second job in the same process can make progress while the first is waiting.
//   MORE WORKERS  is what CPU-BOUND work needs. Resizing an image or hashing a password occupies the event loop, so a 
//                 second job in the same process waits for the first regardless of this setting. Only another process (another core) helps.
//                 Each worker act as a separate event loop, so more workers means more CPU cores can be used in parallel.

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));

// Whether a write has to prove it still holds the job's lease. On by default.
// THIS SWITCH EXISTS TO MAKE A BUG VISIBLE. When a worker is declared dead by mistake, the reaper hands its job to another
// worker while it is still running. Both finish. Without fencing, both write a result — two rows in job_effects for one job.
// With it, every write carries `WHERE lease_id = mine`; the reassigned job has a new lease, so the old worker's UPDATE
// matches zero rows and writes nothing.

const FENCING = (process.env.FENCING ?? "on").toLowerCase() !== "off";

const log = createLogger(WORKER_ID);

// BRPOP/BLMOVE behaves differently from a normal queue pop. It return jobs if present else wait infinitely for one to arrive. 
// If BRPOP not used we have to ping in every interval to see that job arrived or not. which is costly and adds latency.

const blocking = createRedis(`${WORKER_ID}:blocking`, log);

// Two connections — see redis.ts. `blocking` sits on BLMOVE and can do nothing, cannot carry another command
// else while it waits; `scheduling` carries everything else: heartbeat, LREM, ZADD.
// So: one for blocking and other for everything else. The second one earns its keep (heartbeats). 

// The second connection, and the reason createRedis has always been a factory.
// The ZADD would sit in ioredis's queue until a job happened to arrive, which could be never on an idle queue: the retry would simply not be scheduled.
// So: one connection blocks, one works. The heartbeat will use this one too, for exactly the same reason.

const scheduling = createRedis(`${WORKER_ID}:scheduling`, log);

// Postgres gets a pool rather than a single connection, because nothing here parks a connection indefinitely the way BLMOVE does.
const db = createDb(WORKER_ID, log);

// This worker's own processing list. Computed once because it appears in the hot loop, and because a typo here would be the exact silent bug KEYS exists to stop.
const PROCESSING = KEYS.processing(WORKER_ID);

async function processOne(jobId: string): Promise<void> {
  // Redis stores only ID. Based on redis ID, we will fetch the job row from Postgres.
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

  // The row has three timestamps: started_at - created_at is queue wait (a property of this system), 
  // completed_at - started_at is execution time (a property of the work). Measuring them together is the standard benchmarking mistake.
  // 1. attempts is incremented in the DB here, so the crashes still counts as an attempt.
  // 2. check that jobs is claimable or not.
  // 3. lease_id = gen_random_uuid(), so that worker can own the job and if previous owned by other worker, it cannot write to the job row anymore. 
  // This is the fencing mechanism to avoid two workers writing to the same job row.

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
    // Somebody else owns it, or it is already finished.
    log.info(job.id, `not claimable — row says '${job.status}', leaving it alone`);
    return;
  }

  // Take the new count from RETURNING rather than adding one in JavaScript.
  job.attempts = claim.attempts;

  // This execution's proof of ownership. Every write below has to show it.
  const lease = claim.lease_id;

  try {
    await handlers[job.type](job, log);

    // SUCCESS — and the two writes below are one transaction on purpose.

    // job_effects is the evidence that the correctness queries read.
    // if we do only one of the two writes below, the proof would be wrong. the job_effects table shows what work was done, 
    // and jobs table tell what work was claimed. If only one of those two writes lands, the proof is wrong:
    // so we need transection here. 
    // we have used a client out of pool rather than the query because may be BEGIN happens through pool which are free
    // and then so the commit. But we want in one connection, so we have used client out of pool. We want both BEGIN and COMMIT happens on same connection.

    const client = await db.connect();
    let fenced = false;

    try {
      await client.query("BEGIN");

      // update job first it will return a row and then we will check the rowCount. If rowCount is 0 means lease_id is changed by
      // other worker means you don't own it anymore. so we will not insert into job_effects and do rollback.
      // If rowCount is 1 means worker own the job and we insert into the job_effects about what happens to the job.

      // `$3::boolean IS FALSE OR ...` is the FENCING switch, passed as a parameter rather than spliced into the SQL text. 
      // Same discipline as everywhere else here — the query string is a constant, and values travel separately.

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
      // Worker don't own the job anymore, so it cannnot record the outcome. 
      // This means either worker is holding wrong lease_id or the job is transferred to other worker. 
      // That is the honest shape of the guarantee: at-least-once delivery, plus a consumer that recognises a repeat,
      // which together produce an exactly-once EFFECT. Exactly-once delivery was never on the table.
      log.error(
        job.id,
        `fenced out — finished the work, but the lease was reissued while it ran.` +
        ` Another worker owns this job now, so nothing was recorded.`,
      );
      return;
    }

    log.info(job.id, "succeeded");
  } catch (err) {
    // FAILURE — retry, or give up.
    const message = err instanceof Error ? err.message : String(err);

    if (job.attempts >= job.maxAttempts) {
      // Out of attempts. 'dead' is terminal, and the dead-letter queue. A DLQ is an inbox, not a graveyard: 
      // someone reads it, fixes the cause, and replays. That is what POST /jobs/:id/replay is for.

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

    // Row first, then the sorted set — the same ordering as the API's insert-then-enqueue, for the same reason. 
    // A crash between the two leaves a 'retrying' row with a next_run_at that a query can find. Reversed,
    // it would leave a scheduled id whose row still says 'running', and nothing would reconcile it.

    const parked = await query<{ id: string }>(
      db,
      `UPDATE jobs SET status = 'retrying', last_error = $2, next_run_at = $3
        WHERE id = $1 AND ($5::boolean IS FALSE OR lease_id = $4)
        RETURNING id`,
      [job.id, message, runAt, lease, FENCING],
    );

    // FENCED, AND THIS IS THE BRANCH THAT MATTERS MOST.
    // Without the check above, a worker that had been declared dead and whose handler then failed would
    // happily ZADD the job into the delayed set — while another worker was in the middle of running it successfully.
    // The scheduler would promote it when the backoff elapsed and the job would run a THIRD
    // time, scheduled by a process that had no right to speak for it.

    // Returning before the ZADD is what stops a stale worker injecting phantom
    // retries into a job somebody else is handling.

    if (parked.length === 0) {
      log.error(
        job.id,
        `fenced out while failing — no retry scheduled, another worker owns this job now`,
      );
      return;
    }
    // ZADD, not sleep().
    // sleeping will hold worker for some constant time waiting, worker killed during sleep would take retry with it (lost). 
    // Parking the job in Redis return job immediately, survives this process entirely, and lets ANY worker run the job once the scheduler promotes it.
    // The score is the epoch-ms it becomes due, which is what makes
    // ZRANGEBYSCORE 0 <now> the whole of "what is due?".

    await scheduling.zadd(KEYS.delayed, runAt.getTime(), job.id);

    log.error(
      job.id,
      `attempt ${job.attempts}/${job.maxAttempts} failed: ${message}` +
      ` — retry in ${(delayMs / 1000).toFixed(1)}s`,
    );
  }
}

// No lock needed. Redis is single-threaded, so simultaneous BLMOVEs are serialised
// and each job goes to exactly one worker. The semaphore below limits how many jobs
// THIS process holds; it is not what stops two workers taking the same job.
// The semaphore caps how many jobs THIS process runs at once (CONCURRENCY). acquire() waits
// if all slots are taken.

const slots = new Semaphore(CONCURRENCY);


// 1. is there an alive key under MY name?
//    yes → wait up to TTL+1s for it to expire
//          still there? → someone else is using my WORKER_ID → log, do nothing, return
// 2. read my processing list
// 3. UPDATE those rows back to 'queued'
// 4. LMOVE each id back to pending

// On restart, put back whatever this worker was holding — faster than waiting for the reaper.
// If an alive key exists under our name, wait for it to expire (it's probably our own stale one
// from the process that just died). If it's STILL there after TTL+1s, another process is using
// this WORKER_ID — don't touch the list, just warn.

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

  // Rows first, then the list — the same ordering as everywhere else in this project, for the same reason.
  // These rows still say 'running' from the claim the dead process made; put them back to 'queued' before 
  // the ids become takeable, so no worker can ever pick up an id whose row still claims someone else is on it.

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

  // THIS ORDER IS LOAD-BEARING.
  //   1. recover — must run while no alive key exists, since the absence of that
  //      key is exactly what proves no other process owns this WORKER_ID.
  //   2. heartbeat — must land BEFORE the first job is taken. A worker holding a
  //      job while looking dead is a worker the reaper will rob.
  //   3. take work.
  // Swap the first two and a restarting worker would refuse to recover its own
  // stranded jobs, because it would find its own heartbeat and conclude a rival was using its name.

  await recoverOwnProcessing();
  await startHeartbeat(scheduling, WORKER_ID, log);

  log.info(null, `worker ${WORKER_ID} up, concurrency ${CONCURRENCY}, waiting on ${KEYS.pending}`);

  while (true) {
    // Backpressure
    // Acquire a slot BEFORE popping. If we pop first and then acquire, we might pop more jobs
    // than CONCURRENCY because of the await — one worker ends up holding all the jobs, pending
    // becomes empty, and if this worker crashes all of those jobs are lost together. Other
    // workers sit idle because there is nothing left in pending for them to take.

    await slots.acquire();
    // BLMOVE - Blocking List MOVE — rather than polling, and rather than BRPOP.
    // 1. If you use normal popping from queue you do need keep polling in every interval that new job arrived
    // or not. But BRPOP/BLMOVE give concept of infinite wait if job queue is empty using blocking. And this Blocking beats the polling.
    // 2. Using BRPOP gives job to the worker and then redis have nothing no evidence of job, so there is no possibility of
    // retrying or marking dead job and if worker dies DB just say running so no backtracking. By using BLMOVE we pop from the 
    // pending queue and push into the worker's processing list (`queueflow:processing:w1`) as an atomic operation. 
    // Now we have record in processing:worker_id we can backtrack use heartbeat to see the worker alive etc.

    // "RIGHT", "LEFT": take from pending's tail (oldest job, so FIFO order holds) and push onto the
    // head of the processing list. The trailing `0` is the timeout in seconds — 0 means wait forever.

    const jobId = await blocking.blmove(KEYS.pending, PROCESSING, "RIGHT", "LEFT", 0);

    if (jobId === null) {
      slots.release(); // nothing taken, so give the slot straight back
      continue; // only on timeout, which cannot happen with 0.
    }

    // What came off the socket is a string. Postgres would reject a malformed uuid with a type error
    // anyway, but failing here says something useful about where the bad value came from.
    if (!isUuid(jobId)) {
      log.error(null, `discarded non-uuid queue entry: ${jobId.slice(0, 80)}`);

      // It is sitting in this worker's processing list now, and it is junk. Drop it from there too, 
      // or the reaper will faithfully rescue it back into pending for the rest of time.
      await scheduling.lrem(PROCESSING, 1, jobId);

      slots.release();
      continue;
    }

    // NOT awaited — and that is the change that lifts the ceiling.

    // Previously this line was `await processOne(jobId)`, so the loop could not reach BLMOVE again
    // until the handler finished. One job at a time, always: five 8-second jobs took 40 seconds on an idle machine.

    // Now the await is on the SLOT, not on the job. The loop comes straight back around and blocks
    // on the next BLMOVE while this job runs, so up to CONCURRENCY jobs are in flight and the limit is
    // capacity rather than sequence.

    // WHICH BRANCH RUNS IS THE RELEASE PROTOCOL, and it is the counterpart to the BLMOVE above. 
    // The id stays in the processing list for exactly as long as this worker is still responsible for the job:

    //   resolved — processOne reached a terminal state AND recorded it: succeeded,
    //              dead, parked for a retry, or a missing row it logged and gave up
    //              on. Postgres now holds the outcome, so the id has no further
    //              claim on anybody, and LREM releases it.
    //
    //   rejected — something failed at a point where the outcome could NOT be
    //              recorded — Postgres unreachable, most likely. DELIBERATELY NO
    //              LREM. The id stays in the processing list, and once this worker
    //              stops heartbeating the reaper will return it to pending and it
    //              will run again.

    // That asymmetry is a choice, and it is the same one the whole project keeps
    // making: losing a job is unrecoverable, running one twice is merely something
    // to be idempotent about. When in doubt, hold on to it.

    // `void` marks the floating promise as deliberate. `.finally` returns the slot
    // on every path — a slot leaked here would shrink this worker's capacity
    // permanently and silently until it stopped taking work altogether.

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
