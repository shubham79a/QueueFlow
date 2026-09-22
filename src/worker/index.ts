import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { Semaphore } from "../shared/semaphore.js";
import { startHeartbeat, TTL_S } from "../shared/heartbeat.js";
import { onShutdown } from "../shared/shutdown.js";
import { nextDelayMs } from "../shared/retry.js";
import { hostname } from "node:os";
import { isUuid, rowToJob, type JobRow } from "../shared/types.js";
import { handlers } from "./handlers.js";

// This worker's name. It is not just a log label — it names the Redis key holding this
// worker's in-flight jobs, so two processes sharing it share that list.
//
// Falls back to the hostname rather than a fixed "w1" because of how this is deployed:
// in a container the hostname is the container id, so `--scale worker=3` gives three
// distinct ids for free. A hardcoded default would have all three replicas claiming one
// name, which is the failure GAP-5.5 describes. Locally .env sets it explicitly.
const WORKER_ID = process.env.WORKER_ID || hostname();


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

// How long a stopping worker waits for its in-flight jobs to finish before giving up.
//
// THIS MUST STAY BELOW THE ORCHESTRATOR'S GRACE PERIOD — `stop_grace_period` in compose,
// `terminationGracePeriodSeconds` in Kubernetes, 10s by default in both. Docker sends
// SIGTERM, waits that long, then SIGKILLs. If this number is the larger of the two we
// get killed mid-drain and never reach the cleanup at the end, which is worse than not
// draining at all: the jobs are stranded anyway AND the heartbeat is left behind, so
// recovery waits out the full TTL.
//
// 25s against the 30s grace period set for the worker in docker-compose.prod.yml.
const SHUTDOWN_TIMEOUT_MS = Math.max(0, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000));

// How often the drain re-checks whether the last job has finished.
const DRAIN_POLL_MS = 100;

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

// Set by the shutdown handler. Read at the top of the main loop, and also used to tell
// a deliberate BLMOVE failure from a real one — see the catch in main().
let stopping = false;

// Resolves when the main loop has actually left, which the drain waits for before it
// counts what is in flight.
//
// WITHOUT THIS THE COUNT IS WRONG, and wrong in the direction that matters. Slots are
// acquired BEFORE the BLMOVE, not after — that is the backpressure that stops one worker
// hoovering up the whole queue. So an idle worker parked on BLMOVE is already holding a
// slot, and `slots.inFlight` reads 1 with no job running at all. Measuring before the
// loop has released it reports phantom work, and with a short timeout would report
// abandoning a job that never existed.
let loopHasExited!: () => void;
const loopExit = new Promise<void>((resolve) => { loopHasExited = resolve; });


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

/**
 * Stop taking new work, finish what is already in hand, then exit.
 *
 * This is the counterpart to the reaper, not a replacement for it. The reaper handles
 * processes that got no chance to run code; this handles the far commoner case where
 * something asked the process to stop — a deploy, a restart, Ctrl+C. Until now those
 * were the same event: the process died mid-job, its ids sat in the processing list,
 * and the reaper returned them ~35s later to be re-run from zero. At CONCURRENCY=20
 * across three workers, that is sixty jobs per release going through the path built
 * for hardware failure.
 *
 * THE ORDER HERE IS LOAD-BEARING, in the same way the startup order is.
 */
async function drain(): Promise<void> {
  stopping = true;

  // 1. STOP TAKING NEW WORK/JOBS.
  // A flag alone cannot do this. The loop is parked inside `BLMOVE ... 0`, which blocks
  // indefinitely by design — on an idle queue nothing will ever return from it, so the
  // loop would never come back around to read the flag.

  // disconnect() is what wakes it: ioredis marks the connection as deliberately closed
  // (so the retryStrategy does NOT reconnect it) and rejects the parked command. The
  // loop catches that rejection, sees `stopping`, and exits normally.
  blocking.disconnect();

  // Wait for the loop to actually leave before counting anything, so the slot it was
  // holding while parked on BLMOVE is not mistaken for a running job.
  //
  // The race is not just defensive. The loop has two places it can be waiting, and
  // disconnect() only wakes one of them: parked on BLMOVE it returns in milliseconds,
  // but blocked on slots.acquire() — every slot busy, which is exactly when a drain
  // matters most — it cannot move until a job finishes. In that case it is holding no
  // slot, so inFlight is already correct and there is nothing to wait for. Hence a cap
  // rather than an await: at worst this costs a second on a busy worker.
  await Promise.race([loopExit, new Promise((r) => setTimeout(r, 1_000))]);

  // 2. KEEP BEATING WHILE DRAINING.
  //
  // The heartbeat deliberately stays running here. A worker that stops beating while it
  // is still holding jobs is a worker the reaper will rob — it would hand those jobs to
  // somebody else while this process is still running them, which is precisely the
  // double-execution this whole shutdown exists to avoid. The heartbeat stops at step 4,
  // once there is nothing left to protect.

  // 3. WAIT FOR THE WORK IN HAND.
  const held = slots.inFlight;
  if (held > 0) {
    log.info(null, `draining ${held} job(s) in flight, up to ${SHUTDOWN_TIMEOUT_MS}ms`);
  }

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (slots.inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }

  const abandoned = slots.inFlight;

  // 4. CLEAN UP, OR DELIBERATELY DO NOT.
  if (abandoned === 0) {
    heartbeat?.stop();

    // DEL rather than letting the key lapse, and this is the part that pays for itself
    // on every restart. `recoverOwnProcessing` refuses to touch the processing list
    // while a heartbeat exists under this worker's name, and waits TTL_S + 1s for one to
    // expire before giving up. Removing the key on a clean exit means the replacement
    // process starts instantly instead of standing still for half a minute.
    //
    // It is only safe BECAUSE the drain finished. There is nothing left in the list for
    // the reaper to find, so telling the world "this worker is gone" costs nothing.
    await scheduling.del(KEYS.alive(WORKER_ID));

    if (held > 0) log.info(null, `drained cleanly — ${held} job(s) finished`);
  } else {
    // Out of time. Leave the heartbeat alone so it expires on its own, and let the
    // reaper do exactly what it does today. That is the honest outcome for work that did
    // not finish: no better than before this change, and no worse either.
    log.error(
      null,
      `gave up with ${abandoned} job(s) still running — leaving them for the reaper.` +
      ` Raise SHUTDOWN_TIMEOUT_MS (and the orchestrator's grace period with it) if this` +
      ` is routine.`,
    );
  }

  // 5. LET GO OF THE CONNECTIONS. `blocking` is already disconnected above.
  await scheduling.quit().catch(() => scheduling.disconnect());
  await db.end().catch(() => undefined);
}

// Captured so the drain can stop it. Assigned in main(), before any job is taken.
let heartbeat: { stop(): void } | null = null;

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
  heartbeat = await startHeartbeat(scheduling, WORKER_ID, log);

  // REGISTERED AFTER THE HEARTBEAT, NOT BEFORE, and this ordering is a correctness
  // matter rather than tidiness.
  //
  // The drain ends by deleting worker:<WORKER_ID>:alive, which is only ours to delete
  // once startHeartbeat has written it. Earlier than this, recoverOwnProcessing may be
  // sitting out its TTL_S + 1s wait on a key belonging to ANOTHER live process using the
  // same WORKER_ID — the case GAP-5.5 describes. Draining there would delete that
  // process's heartbeat, and the reaper would rob a worker that is running perfectly
  // well.
  //
  // The cost is a window during startup where SIGTERM is still ignored, so a stop issued
  // during recovery waits out the orchestrator's grace period and ends in SIGKILL.
  // Harmless — nothing is in flight yet, which is exactly why there is nothing to drain.
  onShutdown(log, drain);

  log.info(null, `worker ${WORKER_ID} up, concurrency ${CONCURRENCY}, waiting on ${KEYS.pending}`);

  while (!stopping) {
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

    let jobId: string | null;

    try {
      jobId = await blocking.blmove(KEYS.pending, PROCESSING, "RIGHT", "LEFT", 0);
    } catch (err) {
      slots.release(); // nothing was taken, so the slot is not owed to a job

      // The expected way out. drain() disconnects this connection precisely to break
      // the block above, so a rejection while stopping is the shutdown working.
      if (stopping) break;

      // Anything else is real. maxRetriesPerRequest is null and the retryStrategy
      // reconnects, so a genuine failure here is rare enough to be worth surfacing
      // rather than swallowing in a tight retry loop.
      throw err;
    }

    // A job MAY have been moved into the processing list at the instant the connection
    // went, with the reply lost on the way back. That id is then in PROCESSING with a row
    // still saying 'queued', and inFlight never counted it — so the drain will report a
    // clean exit while one id sits behind. It is safe: this worker's heartbeat is deleted
    // on a clean exit, so the reaper finds it on its next pass rather than after the TTL,
    // and recoverOwnProcessing would catch it on restart regardless. The same choice as
    // everywhere else here — when the outcome is unknown, hold on to the job.

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

  // The loop is out, so the slot it held while parked on BLMOVE is back. Only now does
  // slots.inFlight mean "jobs still running", which is what the drain is waiting to read.
  loopHasExited();
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
