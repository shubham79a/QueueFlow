import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";

/**
 * The retry scheduler.
 *
 * One job: move jobs whose backoff has elapsed out of the delayed sorted set and
 * back onto the pending list, where any worker can take them.
 *
 * A separate process rather than a loop inside each worker, for two reasons. It is
 * visible — you can watch it, and you can kill it and see retries stop, which is
 * the honest way to learn that it is a single point of failure. And it keeps the
 * worker's job description to one sentence.
 */
const SCHEDULER_ID = process.env.SCHEDULER_ID ?? "s1";

/** Never sleep longer than this, even if nothing is due, so a new job is noticed. */
const MAX_SLEEP_MS = 1000;

/** Cap on how many jobs are promoted per pass, so one burst cannot monopolise. */
const BATCH = 100;

const log = createLogger(SCHEDULER_ID);
const redis = createRedis(SCHEDULER_ID, log);
const db = createDb(SCHEDULER_ID, log);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Promote everything currently due. Returns how many moved.
 */
async function promoteDue(): Promise<number> {
  const now = Date.now();

  // Everything scored at or before now. The sorted set makes this a range read
  // rather than a scan — the reason a ZSET is the right structure here.
  const due = await redis.zrangebyscore(KEYS.delayed, 0, now, "LIMIT", 0, BATCH);
  if (due.length === 0) return 0;

  let promoted = 0;

  for (const jobId of due) {
    /**
     * ZREM IS THE CLAIM, and it is why several schedulers can run safely.
     *
     * Redis executes commands one at a time, so if two schedulers both see this
     * job as due, exactly one of their ZREMs removes it and returns 1; the other
     * returns 0 and skips. No lock, no leader election — the same atomicity that
     * stops two workers taking the same job from the pending list.
     *
     * Doing this the obvious way instead — read, then push, then remove — would
     * let both schedulers push the id, and the job would run twice.
     */
    const claimed = await redis.zrem(KEYS.delayed, jobId);
    if (claimed !== 1) continue;

    /**
     * Row first, then the push — the same ordering as everywhere else. A crash
     * between them leaves a row saying 'queued' with an id that is in neither
     * Redis structure: an orphan a query can find (GAP-2.1), rather than a worker
     * receiving an id whose row still claims to be waiting for a retry.
     */
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

/**
 * How long to wait before looking again.
 *
 * THIS IS THE ONE PLACE IN THE PROJECT WHERE POLLING IS UNAVOIDABLE, and the
 * contrast with the worker is deliberate. BRPOP exists because Redis can tell you
 * the instant a list gains an element. There is no equivalent for "wake me when
 * this score becomes reachable" — time passing is not an event Redis can notify on.
 *
 * So instead of polling blindly at a fixed interval, ask the sorted set when its
 * earliest job is due and sleep until then, capped at MAX_SLEEP_MS so a newly
 * scheduled job is not missed. An empty delayed set costs one ZRANGE per second.
 */
async function sleepUntilNextDue(): Promise<void> {
  const [, score] = await redis.zrange(KEYS.delayed, 0, 0, "WITHSCORES");
  if (score === undefined) return sleep(MAX_SLEEP_MS);

  const waitMs = Number(score) - Date.now();
  await sleep(Math.max(0, Math.min(waitMs, MAX_SLEEP_MS)));
}

async function main(): Promise<void> {
  log.info(null, `scheduler ${SCHEDULER_ID} up, watching ${KEYS.delayed}`);

  while (true) {
    const promoted = await promoteDue();
    if (promoted === 0) await sleepUntilNextDue();
  }
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
