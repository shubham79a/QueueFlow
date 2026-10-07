import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { KEYS, scanKeys, workerIdFromProcessingKey } from "../shared/keys.js";
import { query } from "../shared/db.js";
import type { Logger } from "../shared/log.js";
import { isUuid } from "../shared/types.js";

// Recover jobs held by workers whose heartbeat has expired.
// A missing heartbeat can be a false failure signal, so recovery may cause
// duplicate execution. That is acceptable with at-least-once processing;
// lease fencing prevents stale workers from committing old DB state.

// Minimum age before a queued row is treated as an orphan.
// Must exceed normal queue wait time to avoid requeueing legitimate backlog.
const ORPHAN_AGE_S = Math.max(5, Number(process.env.ORPHAN_AGE_S ?? 60));

// Limit recovery work per pass so a large failure cannot monopolize the loop.
const BATCH = 100;

// Collect job IDs currently held by pending or any worker processing list.
// Only called when orphan candidates exist because reading whole lists is expensive.
async function idsHeldByRedis(redis: Redis): Promise<Set<string>> {
  const held = new Set(await redis.lrange(KEYS.pending, 0, -1));

  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    for (const id of await redis.lrange(key, 0, -1)) held.add(id);
  }

  return held;
}

// Recover all jobs held by one dead worker.
async function reapWorker(
  redis: Redis,
  db: Pool,
  log: Logger,
  key: string,
  workerId: string,
): Promise<number> {
  let reaped = 0;

  // Each iteration removes or moves one entry, so the processing list shrinks and the loop terminates.
  while (true) {
    const jobId = await redis.lindex(key, -1);
    if (jobId === null) break;

    // Remove malformed Redis entries instead of sending invalid IDs into recovery.
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

    // Redis has an ID with no durable Postgres row, so it cannot be recovered safely.
    if (!row) {
      log.error(jobId, `held by dead worker ${workerId} but has no row — discarded`);
      await redis.lrem(key, -1, jobId);
      continue;
    }

    // These states were already handled elsewhere, so the Redis entry is stale.
    // 1. succeeded/dead/failed: outcome was recorded before the worker crashed.
    // 2. retrying: failure was recorded and the job was placed in the delayed ZSET.
    // 3. running and queued are recoverable: the worker may have died during execution,
    // or the Redis move may have happened before the DB claim completed.
    if (["succeeded", "dead", "failed", "retrying"].includes(row.status)) {
      await redis.lrem(key, -1, jobId);
      log.info(jobId, `released from dead worker ${workerId} — already ${row.status}`);
      continue;
    }

    // The attempt was already counted when claimed. If the retry budget is exhausted,
    // mark the job dead instead of sending it through the worker loop again.
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

    // Update Postgres before moving the Redis entry so another worker sees the job
    // as queued before it can claim it.
    // Keep the attempt count because the crashed execution consumed an attempt.
    // The next claim gets a fresh lease, so a stale worker cannot commit old state.
    await query(
      db,
      `UPDATE jobs SET status = 'queued', started_at = NULL WHERE id = $1`,
      [jobId],
    );
    // Atomically move the rescued job back to pending.
    // RIGHT → RIGHT places it at the front of pending because it has already waited.
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
