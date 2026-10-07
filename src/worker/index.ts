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

// Use an explicit worker ID when provided; otherwise use the container hostname.
const WORKER_ID = process.env.WORKER_ID || hostname();

// How many jobs this ONE process may have in flight at once.
// This is a different dial from "how many worker processes are running":
//   CONCURRENCY   helps only for IO-BOUND work. IO-BOUND tasks means which are done by external services, like a
//   (EVENT LOOP)  webhook or a database query or redis. While one job is waiting for the external service to respond
//                 another job can be started in the same process, so a second job in the same process can make progress while the first is waiting.
//   MORE WORKERS  is what CPU-BOUND work needs. Resizing an image or hashing a password occupies the event loop, so a 
//                 second job in the same process waits for the first regardless of this setting. Only another process (another core) helps.
//                 Each worker act as a separate event loop, so more workers means more CPU cores can be used in parallel.

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));

// Enable/disable lease fencing for testing stale-worker writes.
const FENCING = (process.env.FENCING ?? "on").toLowerCase() !== "off";

// Maximum time to wait for in-flight jobs during shutdown.
// Must stay below the orchestrator's termination grace period so the worker
// can finish draining before it is force-killed.
const SHUTDOWN_TIMEOUT_MS = Math.max(0, Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000));

// How often the drain re-checks whether the last job has finished.
const DRAIN_POLL_MS = 100;

const log = createLogger(WORKER_ID);

// BRPOP/BLMOVE behaves differently from a normal queue pop. It return jobs if present else wait infinitely for one to arrive. 
// If BLMOVE not used we have to ping in every interval to see that job arrived or not. which is costly and adds latency.
const blocking = createRedis(`${WORKER_ID}:blocking`, log);

// Separate connection for heartbeat, LREM, ZADD, and other non-blocking commands.
// The blocking connection cannot be used for these while waiting on BLMOVE.
const scheduling = createRedis(`${WORKER_ID}:scheduling`, log);

// Postgres gets a pool rather than a single connection, because nothing here parks a connection indefinitely the way BLMOVE does.
const db = createDb(WORKER_ID, log);

// This worker's own processing list. Computed once because it appears in the hot loop, and because a typo here would be the exact silent bug KEYS exists to stop.
const PROCESSING = KEYS.processing(WORKER_ID);

async function processOne(jobId: string): Promise<void> {
  // Redis stores only the job ID; fetch the durable job data from Postgres.
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
    const client = await db.connect();
    let fenced = false;
    try {
      await client.query("BEGIN");

      // Record success only if this worker still owns the current lease.
      // Insert the job effect in the same transaction so the state change and
      // recorded effect either both commit or both roll back.
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
      // Always return the database client to the pool.
      client.release();
    }

    if (fenced) {
      // The worker finished the work but lost ownership before recording the result.
      // Do not write a stale outcome; another worker now owns the job.
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
      // Exhausted attempts make the job dead.
      // Dead jobs can later be inspected and replayed by an operator.
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

    // Persist the retry state in Postgres before adding the job to the delayed set.
    // If the process crashes between these writes, the database still records that the job needs recovery.
    const parked = await query<{ id: string }>(
      db,
      `UPDATE jobs SET status = 'retrying', last_error = $2, next_run_at = $3
        WHERE id = $1 AND ($5::boolean IS FALSE OR lease_id = $4)
        RETURNING id`,
      [job.id, message, runAt, lease, FENCING],
    );

    // Only the current lease owner may schedule the retry.
    // A stale worker must not inject a retry after another worker has taken ownership.
    if (parked.length === 0) {
      log.error(
        job.id,
        `fenced out while failing — no retry scheduled, another worker owns this job now`,
      );
      return;
    }
    // Store the retry in the delayed sorted set instead of sleeping.
    // The job survives worker failure and can be promoted by any scheduler.
    // The score is the timestamp when the job becomes due.
    await scheduling.zadd(KEYS.delayed, runAt.getTime(), job.id);

    log.error(
      job.id,
      `attempt ${job.attempts}/${job.maxAttempts} failed: ${message}` +
      ` — retry in ${(delayMs / 1000).toFixed(1)}s`,
    );
  }
}

// No lock needed. Redis is single-threaded, so simultaneous BLMOVEs are serialised and each job goes to exactly one worker.
// The semaphore caps how many jobs THIS process runs at once (CONCURRENCY). acquire() waits if all slots are taken.
const slots = new Semaphore(CONCURRENCY);

// Set by the shutdown handler. Read at the top of the main loop, and also used to tell
// a deliberate BLMOVE failure from a real one — see the catch in main().
let stopping = false;

// Resolves when the main loop has actually left, which the drain waits for before it counts what is in flight.
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

  // Give the previous process time for its heartbeat to expire.
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

  // Only recover jobs if this WORKER_ID is no longer alive.
  const stranded = (await scheduling.lrange(PROCESSING, 0, -1)).filter(isUuid);
  if (stranded.length === 0) return;

  // Restore DB state before making the jobs available again.
  await query(
    db,
    `UPDATE jobs SET status = 'queued', started_at = NULL
      WHERE id = ANY($1::uuid[]) AND status = 'running'`,
    [stranded],
  );

  // Tail to tail: Move stranded jobs back to pending so workers can retry them.
  let moved = 0;
  while ((await scheduling.lmove(PROCESSING, KEYS.pending, "RIGHT", "RIGHT")) !== null) {
    moved += 1;
  }

  log.info(null, `recovered ${moved} job(s) stranded by a previous run of ${WORKER_ID}`);
}

// Gracefully stop the worker:
// stop taking new jobs, finish in-flight jobs, then exit. If jobs cannot finish in time, leave them for the reaper.
async function drain(): Promise<void> {
  stopping = true;

  // 1. Stop taking new jobs. Disconnecting wakes the blocking BLMOVE which help enqueue new jobs and 
  // kept waiting if no job found in pending.
  blocking.disconnect();

  // Wait for the worker loop to exit (main function), but don't block shutdown forever.
  await Promise.race([loopExit, new Promise((r) => setTimeout(r, 1_000))]);

  // 2. Keep the heartbeat alive while finishing jobs so the reaper doesn't treat this worker as dead and reassign its jobs. 
  // Heartbeat stops only after the drain finishes, so the reaper sees this worker as alive until it is actually gone.
  const held = slots.inFlight;
  if (held > 0) {
    log.info(null, `draining ${held} job(s) in flight, up to ${SHUTDOWN_TIMEOUT_MS}ms`);
  }

  // 3. Wait for in-flight jobs to finish, up to the shutdown timeout.
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (slots.inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }
  const abandoned = slots.inFlight;

  // 4. All jobs finished. Stop the heartbeat and remove the alive key.
  if (abandoned === 0) {
    heartbeat?.stop();
    await scheduling.del(KEYS.alive(WORKER_ID));

    if (held > 0) log.info(null, `drained cleanly — ${held} job(s) finished`);
  } else {
    // Jobs are still running. Keep the heartbeat and let the reaper recover them.
    log.error(
      null,
      `gave up with ${abandoned} job(s) still running — leaving them for the reaper.` +
      ` Raise SHUTDOWN_TIMEOUT_MS (and the orchestrator's grace period with it) if this` +
      ` is routine.`,
    );
  }

  // 5. Close Redis and Postgres connections.
  await scheduling.quit().catch(() => scheduling.disconnect());
  await db.end().catch(() => undefined);
}

// Captured so the drain can stop it. Assigned in main(), before any job is taken.
let heartbeat: { stop(): void } | null = null;

// Startup order: recover stranded jobs, start heartbeat, then accept new work.
async function main(): Promise<void> {
  // Startup order matters:
  // 1. Recover stranded jobs.
  // 2. Start the heartbeat before taking new work.
  // 3. Register shutdown handling.
  // 4. Start processing jobs.
  // The heartbeat must exist before a job is taken, otherwise the reaper could
  // mistake this worker for dead and recover a job it is actively processing.
  await recoverOwnProcessing();
  heartbeat = await startHeartbeat(scheduling, WORKER_ID, log);

  // REGISTERED AFTER THE HEARTBEAT, NOT BEFORE, and this ordering is a correctness matter rather than tidiness.
  
  // The drain ends by deleting worker:<WORKER_ID>:alive, which is only ours to delete
  // once startHeartbeat has written it. Earlier than this, recoverOwnProcessing may be
  // sitting out its TTL_S + 1s wait on a key belonging to ANOTHER live process using the
  // same WORKER_ID — the case GAP-5.5 describes. Draining there would delete that
  // process's heartbeat, and the reaper would rob a worker that is running perfectly well.
  
  // The cost is a window during startup where SIGTERM is still ignored, so a stop issued
  // during recovery waits out the orchestrator's grace period and ends in SIGKILL.
  // Harmless — nothing is in flight yet, which is exactly why there is nothing to drain.
  onShutdown(log, drain);

  log.info(null, `worker ${WORKER_ID} up, concurrency ${CONCURRENCY}, waiting on ${KEYS.pending}`);

  while (!stopping) {
    // Acquire a slot before taking a job to enforce per-process concurrency.
    // Backpressure
    await slots.acquire();

    // Atomically move a job from pending to this worker's processing list.
    // Blocks until a job is available.
    // "RIGHT", "LEFT": take from pending's tail (oldest job, so FIFO order holds) and push onto the
    // head of the processing list. The trailing `0` is the timeout in seconds — 0 means wait forever.
    let jobId: string | null;

    try {
      jobId = await blocking.blmove(KEYS.pending, PROCESSING, "RIGHT", "LEFT", 0);
    } catch (err) {
      slots.release(); // nothing was taken, so the slot is not owed to a job

      // During shutdown, disconnecting BLMOVE is expected; otherwise rethrow the error.
      if (stopping) break;
      throw err;
    }

    // If the move succeeded but the reply was lost, the job remains in processing and can be recovered by the reaper.
    if (jobId === null) {
      slots.release(); // nothing taken, so give the slot straight back
      continue; // only on timeout, which cannot happen with 0.
    }
    // Reject malformed queue entries and remove them from the processing list.
    if (!isUuid(jobId)) {
      log.error(null, `discarded non-uuid queue entry: ${jobId.slice(0, 80)}`);

      // It is sitting in this worker's processing list now, and it is junk. Drop it from there too, 
      // or the reaper will faithfully rescue it back into pending for the rest of time.
      await scheduling.lrem(PROCESSING, 1, jobId);

      slots.release();
      continue;
    }

    // NOT awaited — and that is the change that lifts the ceiling.
    // Process asynchronously so this worker can take more jobs up to CONCURRENCY. Now  
    // Else (await processOne(jobId)) it will wait for the job to finish before taking another job.
    // Remove the job only after its outcome is recorded.
    // If recording fails, leave it in processing so the reaper can recover it.
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
