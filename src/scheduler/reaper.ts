import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { KEYS, scanKeys, workerIdFromProcessingKey } from "../shared/keys.js";
import { query } from "../shared/db.js";
import type { Logger } from "../shared/log.js";
import { isUuid } from "../shared/types.js";

// The reaper: return the jobs of a worker that is no longer alive.
// This helps the system crash survivable. BLMOVE move job from pending to the `queueflow:processing:<workerId>`.
// when process died, the heartbeat made "is that worker still alive?". If alive fine else push job back to pending.
// But heartbeat not always give you correct alive info, sometime wrong too. this is not fixable.
// Missing heartbeat worker has not spoken recently, which doesn't means worker is dead.
// Using TTL help to avoid those error still not 100% correct.

// So by design: w1 gets marked dead while j1 is still running, the reaper pushes j1 back to
// pending, w2 picks it up and runs it too. The job runs twice — that part we accept. What the
// lease_id prevents is both of them RECORDING it: only the latest claim can write.

// How old a `queued` row must be before the sweep treats it as lost rather than as merely waiting.

// MUST COMFORTABLY EXCEED NORMAL QUEUE WAIT. A backlog where jobs legitimately sit for two minutes, 
// with this set to sixty seconds, would have the sweep re-pushing ids that are already in the queue.

const ORPHAN_AGE_S = Math.max(5, Number(process.env.ORPHAN_AGE_S ?? 60));

// Cap per pass, so one catastrophe cannot monopolise the loop.
const BATCH = 100;

// Every job id Redis is currently holding, across `pending` and every worker's processing list.
// Reading whole lists is not free, which is why the orphan sweep below builds this
// only when it has already found candidate rows — on a healthy system, never.
async function idsHeldByRedis(redis: Redis): Promise<Set<string>> {
  const held = new Set(await redis.lrange(KEYS.pending, 0, -1));

  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    for (const id of await redis.lrange(key, 0, -1)) held.add(id);
  }

  return held;
}

// Return everything one dead worker was holding. Returns how many jobs moved.
async function reapWorker(
  redis: Redis,
  db: Pool,
  log: Logger,
  key: string,
  workerId: string,
): Promise<number> {
  let reaped = 0;

  // Every branch below either LREMs or LMOVEs, so the list shrinks by one on each pass and this 
  // always terminates — including when a second scheduler is racing for the same entries.
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

    // ALREADY ACCOUNTED FOR. Two different cases, both meaning "somebody else has
    // this job now, and the id in this list is just litter":
    // 1.succeeded / dead / failed  the worker recorded the outcome and then died before LREM. Requeueing
    //                              would re-run a job that has already finished.
    // 2.retrying                   the worker wrote the failure and ZADDed the job into the delayed set, 
    //                              then died before the LREM. The scheduler will promote it when it's due. 
    //                              Pushing it to pending here would make it run early, and then again when the ZSET fires.
    // 3.running is the normal case — w1 claimed it, was working, died. queued is the tiny window where BLMOVE put the id in 
    // the list but the claim UPDATE hadn't landed yet. Both need rescuing.

    if (["succeeded", "dead", "failed", "retrying"].includes(row.status)) {
      await redis.lrem(key, -1, jobId);
      log.info(jobId, `released from dead worker ${workerId} — already ${row.status}`);
      continue;
    }

    // The poison-pill cap. attempts was incremented at claim time, so this crash already counted. 
    // If it's used up its budget → mark dead in Postgres, remove the id. Don't push it back — a job that kills every worker it lands on must stop somewhere.
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

    // Row first, then the move. If the id hit pending while the row still said 'running',
    // the next worker's claim (WHERE status IN queued/retrying) would fail and drop the job.
    // started_at cleared — it's back to waiting. attempts kept — the crash was a real attempt.
    // lease_id left alone on purpose: if w1 was slow, not dead, and finishes first, it can still
    // record its result; the next claim reissues the lease anyway.
    // LMOVE tail-to-tail puts the rescued job at the front of pending — it's waited longest.
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

// One reaping pass over every worker's processing list.
// find the dead worker and had over to the reapWorker. which worker is dead?
export async function reapDead(redis: Redis, db: Pool, log: Logger): Promise<number> {
  let reaped = 0;

  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    const workerId = workerIdFromProcessingKey(key);
    if (workerId === null) continue;

    // the worker who keep sending the heartbeat is alive. If not means dead
    if (await redis.exists(KEYS.alive(workerId))) continue;

    // dead worker found
    reaped += await reapWorker(redis, db, log, key, workerId);
  }

  return reaped;
}

// Different problem: the API wrote a row but died before the LPUSH. The row says queued,
// but no id is in Redis anywhere. Nothing will ever pick it up.
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

  // The overwhelmingly common case, and the reason the expensive check below is guarded rather than run every pass.
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
