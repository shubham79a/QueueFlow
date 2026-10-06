import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { onShutdown } from "../shared/shutdown.js";
import { reapDead, sweepOrphans } from "./reaper.js";

// The scheduler. Every 1 sec, reaper case - every 5 sec (costly)
// One job, stated once: PUT JOBS BACK ON THE PENDING LIST. There are three reasons a job needs putting back:
// 1.  its backoff elapsed        promoteDue()   — a failed job whose retry is due
// 2.  its worker stopped talking reapDead()     — a crash, and the job was rescued
// 3.  it was never queued at all sweepOrphans() — the API died mid-enqueue
// All three are the same sentence with a different cause, which is why they belong in one process rather than three.

const SCHEDULER_ID = process.env.SCHEDULER_ID ?? "s1";

// Never sleep longer than this, even if nothing is due, so a new job is noticed.
const MAX_SLEEP_MS = 1000;

// Cap on how many jobs are promoted per pass, so one burst cannot monopolise.
const BATCH = 100;

// How often to look for dead workers and orphaned rows.
// Much less often than the retry check, because both are answers to rare events and both cost more to ask.
// Why reaping runs every 5s, not every pass -- rare events, expensive checks, and recovery is bounded by TTL anyway
const REAP_INTERVAL_MS = Math.max(200, Number(process.env.REAP_INTERVAL_MS ?? 5_000));

const log = createLogger(SCHEDULER_ID);
const redis = createRedis(SCHEDULER_ID, log);
const db = createDb(SCHEDULER_ID, log);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Promote everything currently due. Returns how many moved.
async function promoteDue(): Promise<number> {
  const now = Date.now();

  // Everything scored at or before now. The sorted set makes this a range read
  // rather than a scan — the reason a ZSET is the right structure here.
  const due = await redis.zrangebyscore(KEYS.delayed, 0, now, "LIMIT", 0, BATCH);
  if (due.length === 0) return 0;

  let promoted = 0;

  for (const jobId of due) {

    // ZREM IS THE CLAIM, and it is why several schedulers can run safely.
    // -- Redis executes commands one at a time, so if two schedulers both see this job as due >> only one can get the job
    // due to atomicity. No lock, no leader election — the same atomicity that stops two workers taking the same job 
    // from the pending list. Doing this the obvious way instead — read, then push, then remove — would
    // let both schedulers push the id, and the job would run twice.

    const claimed = await redis.zrem(KEYS.delayed, jobId);
    if (claimed !== 1) continue;

    await query(
      db,
      `UPDATE jobs SET status = 'queued', next_run_at = NULL WHERE id = $1`,
      [jobId],
    );

    await redis.lpush(KEYS.pending, jobId);

    promoted += 1;
    log.info(jobId, "retry due — returned to pending");
  }

  return promoted;
}

// How long to wait before looking again.
// THIS IS THE ONE PLACE IN THE PROJECT WHERE POLLING IS UNAVOIDABLE, and the contrast with the worker is deliberate.
// BLMOVE exists because Redis can tell you the instant a list gains an element. There is no equivalent for 
// "wake me when this score becomes reachable" — time passing is not an event Redis can notify on.
// So instead of polling blindly at a fixed interval, ask the sorted set when its earliest job is due and 
// sleep until then, capped at MAX_SLEEP_MS so a newly scheduled job is not missed. An empty delayed set costs one ZRANGE per second.

async function sleepUntilNextDue(): Promise<void> {
  const [, score] = await redis.zrange(KEYS.delayed, 0, 0, "WITHSCORES");
  if (score === undefined) return sleep(MAX_SLEEP_MS);

  const waitMs = Number(score) - Date.now();
  await sleep(Math.max(0, Math.min(waitMs, MAX_SLEEP_MS)));
}

// The recovery pass — dead workers, then orphans, in that order.
// The order is not arbitrary. Reaping moves ids out of a dead worker's processing list and back into pending; 
// sweeping asks "which 'queued' rows are in no Redis structure at all?". Sweeping first would see rows the reaper 
// is about to fix and push their ids a second time.
async function recoverLostWork(): Promise<void> {
  try {
    const reaped = await reapDead(redis, db, log);
    const swept = await sweepOrphans(redis, db, log);

    if (reaped > 0 || swept > 0) {
      log.info(null, `recovery pass: ${reaped} rescued from dead workers, ${swept} orphans queued`);
    }
  } catch (err) {
    log.error(null, `recovery pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Set by the shutdown handler, read at the top of the loop below.
let stopping = false;

// Resolves once the loop has actually left, which the drain waits for before it closes
// anything. Setting the flag only ASKS the loop to stop; it does not make it so.
let loopHasExited!: () => void;
const loopExit = new Promise<void>((resolve) => { loopHasExited = resolve; });

// Stop after the current pass finishes so we don't leave a
// partially completed promote/recovery operation.
async function drain(): Promise<void> {
  stopping = true;

  // Wait for the loop to exit (main() function loop which handles all reschedule functions), but don't hang shutdown forever.
  // so 5 seconds is max time we will wait later quit both db and redis connections
  const finished = await Promise.race([
    loopExit.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
  ]);

  if (!finished) {
    log.error(null, "a pass did not finish in time — closing underneath it");
  }

  await redis.quit().catch(() => redis.disconnect());
  await db.end().catch(() => undefined);
}

async function main(): Promise<void> {
  onShutdown(log, drain);

  log.info(
    null,
    `scheduler ${SCHEDULER_ID} up, watching ${KEYS.delayed}` +
    ` and reaping every ${REAP_INTERVAL_MS}ms`,
  );

  let nextReapAt = 0;

  while (!stopping) {
    const promoted = await promoteDue();

    // Time-gated rather than run every pass: the loop above spins as fast as work
    // arrives, and the expensive checks should not spin with it.
    if (Date.now() >= nextReapAt) {
      nextReapAt = Date.now() + REAP_INTERVAL_MS;
      await recoverLostWork();
    }

    // sleepUntilNextDue caps at MAX_SLEEP_MS, so the reap gate above is still
    // reached about once a second even when the delayed set is empty.
    if (promoted === 0) await sleepUntilNextDue();
  }

  // Nothing is part way through now, so the drain can close Redis and Postgres safely.
  loopHasExited();
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
