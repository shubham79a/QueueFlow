import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { KEYS, scanKeys, workerIdFromProcessingKey } from "../shared/keys.js";
import { query } from "../shared/db.js";
import type { Logger } from "../shared/log.js";
import { isUuid } from "../shared/types.js";

/**
 * The reaper: return the jobs of a worker that is no longer alive.
 *
 * This is the half of the system that finally makes a crash survivable. BLMOVE
 * left the job id sitting in `queueflow:processing:<workerId>` when the process
 * died; the heartbeat made "is that worker still alive?" a question Redis can
 * answer. This puts the two together and moves the job back to `pending`.
 *
 * IT WILL SOMETIMES BE WRONG, AND THAT IS NOT FIXABLE. A missing heartbeat means
 * "this worker has not spoken recently", which is not the same as "this worker is
 * dead" — a long garbage-collection pause, a stalled network, an overloaded
 * machine all look identical from here. Widening the TTL makes the mistake rarer
 * and the recovery slower; it never makes the mistake impossible, because over a
 * network there is no way to distinguish a process that has stopped from one that
 * is merely quiet.
 *
 * So the design accepts it: this loop will occasionally take a job away from a
 * worker that is still running it, and the job will run twice. Making that
 * harmless is the lease, in the worker.
 */

/**
 * How old a `queued` row must be before the sweep treats it as lost rather than
 * as merely waiting.
 *
 * MUST COMFORTABLY EXCEED NORMAL QUEUE WAIT. A backlog where jobs legitimately sit
 * for two minutes, with this set to sixty seconds, would have the sweep re-pushing
 * ids that are already in the queue.
 */
const ORPHAN_AGE_S = Math.max(5, Number(process.env.ORPHAN_AGE_S ?? 60));

/** Cap per pass, so one catastrophe cannot monopolise the loop. */
const BATCH = 100;

/**
 * Every job id Redis is currently holding, across `pending` and every worker's
 * processing list.
 *
 * Reading whole lists is not free, which is why the orphan sweep below builds this
 * only when it has already found candidate rows — on a healthy system, never.
 */
async function idsHeldByRedis(redis: Redis): Promise<Set<string>> {
  const held = new Set(await redis.lrange(KEYS.pending, 0, -1));

  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    for (const id of await redis.lrange(key, 0, -1)) held.add(id);
  }

  return held;
}

/**
 * Return everything one dead worker was holding. Returns how many jobs moved.
 */
async function reapWorker(
  redis: Redis,
  db: Pool,
  log: Logger,
  key: string,
  workerId: string,
): Promise<number> {
  let reaped = 0;

  // Every branch below either LREMs or LMOVEs, so the list shrinks by one on each
  // pass and this always terminates — including when a second scheduler is racing
  // for the same entries.
  while (true) {
    const jobId = await redis.lindex(key, -1);
    if (jobId === null) break;

    if (!isUuid(jobId)) {
      await redis.lrem(key, -1, jobId);
      continue;
    }

    const rows = await query<{ attempts: number; max_attempts: number; status: string }>(
      db,
      `SELECT attempts, max_attempts, status FROM jobs WHERE id = $1`,
      [jobId],
    );
    const row = rows[0];

    if (!row) {
      log.error(jobId, `held by dead worker ${workerId} but has no row — discarded`);
      await redis.lrem(key, -1, jobId);
      continue;
    }

    /**
     * ALREADY ACCOUNTED FOR. Two different cases, both meaning "somebody else has
     * this job now, and the id in this list is just litter":
     *
     *   succeeded / dead / failed  the worker recorded the outcome and then died
     *                              before it could LREM the id — the deliberately
     *                              chosen crash window in the worker's release
     *                              protocol. Requeueing would re-run a job that
     *                              has already finished.
     *
     *   retrying                   the worker recorded the failure and parked the
     *                              job in the delayed sorted set, then died before
     *                              releasing the id. The scheduler will promote it
     *                              when its backoff elapses; pushing it to pending
     *                              here would run it early AND leave a stale entry
     *                              in the delayed set to run it a second time.
     *
     * EVERY OTHER STATUS IS RESCUED, including 'queued' — which is not a paradox.
     * BLMOVE puts the id in this list a moment BEFORE the worker claims the row,
     * so a process that died inside that window leaves a 'queued' row with its id
     * held by a worker that no longer exists. Nothing else will ever look at it:
     * the id is not in pending, and the orphan sweep skips anything Redis is
     * holding. Treating that as litter loses the job outright.
     */
    if (["succeeded", "dead", "failed", "retrying"].includes(row.status)) {
      await redis.lrem(key, -1, jobId);
      log.info(jobId, `released from dead worker ${workerId} — already ${row.status}`);
      continue;
    }

    /**
     * THE POISON-PILL CAP. A job that kills whatever runs it — a payload that
     * triggers an out-of-memory, say — would otherwise be rescued forever, taking
     * down one worker after another. attempts was incremented when the job was
     * claimed, precisely so a death still counts as an attempt, so the ordinary
     * retry budget applies here with no extra bookkeeping.
     */
    if (row.attempts >= row.max_attempts) {
      await query(
        db,
        `UPDATE jobs SET status = 'dead', last_error = $2, completed_at = now(),
                         next_run_at = NULL
          WHERE id = $1`,
        [jobId, `worker ${workerId} stopped responding while holding this job`],
      );
      await redis.lrem(key, -1, jobId);

      log.error(
        jobId,
        `dead after ${row.attempts} attempts — worker ${workerId} stopped responding holding it`,
      );
      reaped += 1;
      continue;
    }

    /**
     * Row first, then the move — the ordering this project uses everywhere.
     *
     * The row still says 'running' from the claim the dead worker made. Put it back
     * to 'queued' BEFORE the id becomes takeable, so no worker can ever be handed
     * an id whose row still claims somebody else is on it. A crash between the two
     * statements leaves a 'queued' row with the id still in this processing list —
     * which the next pass reaps again, harmlessly.
     *
     * started_at is cleared because the job returns to waiting and that column
     * measures queue wait; leaving it would bill the crash to execution time.
     * attempts is NOT reset — that attempt was genuinely spent.
     *
     * lease_id IS DELIBERATELY LEFT ALONE, and it is worth saying why, because
     * clearing it looks tidier and is worse. Suppose this worker was not dead
     * after all, just quiet, and it finishes a moment from now. Leaving the lease
     * standing lets it record the result it legitimately produced — and then the
     * next worker to pick this id up finds the row already 'succeeded', declines
     * the claim, and drops it. Nothing is run twice and no work is thrown away.
     * Clearing the lease would fence out a worker that was about to finish, purely
     * for the sake of a tidier column. The next real claim reissues it anyway.
     *
     * LMOVE tail-to-tail: onto the end of `pending` that BLMOVE reads from, so a
     * rescued job is served NEXT. It has been waiting longer than anything else in
     * the queue, and it has already been through a crash.
     */
    await query(
      db,
      `UPDATE jobs SET status = 'queued', started_at = NULL WHERE id = $1`,
      [jobId],
    );
    await redis.lmove(key, KEYS.pending, "RIGHT", "RIGHT");

    log.info(
      jobId,
      `rescued from ${workerId} — back in pending (attempt ${row.attempts} was lost with the worker)`,
    );
    reaped += 1;
  }

  return reaped;
}

/**
 * One reaping pass over every worker's processing list.
 */
export async function reapDead(redis: Redis, db: Pool, log: Logger): Promise<number> {
  let reaped = 0;

  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    const workerId = workerIdFromProcessingKey(key);
    if (workerId === null) continue;

    // The entire failure detector, in one command. A living worker keeps rewriting
    // this key; a dead one stops and Redis removes it.
    if (await redis.exists(KEYS.alive(workerId))) continue;

    // An empty list belonging to a departed worker is just a name Redis has
    // already forgotten — LLEN 0 means the key does not exist. Nothing to do.
    reaped += await reapWorker(redis, db, log, key, workerId);
  }

  return reaped;
}

/**
 * The orphan sweep — the other way a job goes missing, and the older one.
 *
 * The API inserts the row and then pushes the id, and nothing can make those two
 * writes atomic because they are in different stores. A crash in between leaves a
 * row that says 'queued' and an id that was never queued anywhere. The job is not
 * lost — that was the entire point of writing the row first — but nothing was ever
 * going to notice it, either. This is the something that notices.
 *
 * IT WAS LEFT OPEN ON PURPOSE UNTIL NOW. Re-pushing an id carries the risk that
 * the id is already in the queue and the job runs twice, and until a duplicate
 * execution was survivable that risk was worse than the leak. The lease is what
 * changed the arithmetic.
 */
export async function sweepOrphans(redis: Redis, db: Pool, log: Logger): Promise<number> {
  const candidates = await query<{ id: string }>(
    db,
    `SELECT id FROM jobs
      WHERE status = 'queued'
        AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at
      LIMIT ${BATCH}`,
    [ORPHAN_AGE_S],
  );

  // The overwhelmingly common case, and the reason the expensive check below is
  // guarded rather than run every pass.
  if (candidates.length === 0) return 0;

  const held = await idsHeldByRedis(redis);
  let requeued = 0;

  for (const { id } of candidates) {
    // Old, but genuinely still in the queue — a backlog, not a leak. Leave it.
    if (held.has(id)) continue;

    await redis.rpush(KEYS.pending, id);
    requeued += 1;

    log.info(id, `orphan — accepted but never queued, pushed to pending`);
  }

  return requeued;
}
