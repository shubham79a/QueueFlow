import { randomUUID } from "node:crypto";
import express from "express";
import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import {
  isJobType,
  rowToJob,
  validatePayload,
  type JobRow,
  type JobStatus,
} from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 4000);

const log = createLogger("api");
const redis = createRedis("api", log);
const db = createDb("api", log);

const app = express();
app.use(express.json());

const JOB_COLUMNS = `id, type, payload, status, attempts, max_attempts,
                     last_error, idempotency_key, created_at, started_at, completed_at,
                     next_run_at`;

/**
 * POST /jobs — the producer.
 *
 * The handler still does not run the job, wait for it, or ever learn whether it
 * succeeded. What changed is that the job now exists somewhere permanent before
 * anyone is told about it.
 */
app.post("/jobs", async (req, res) => {
  const { type, payload } = req.body ?? {};

  if (!isJobType(type)) {
    return res.status(400).json({ error: `unknown job type: ${String(type)}` });
  }
  const invalid = validatePayload(type, payload);
  if (invalid) return res.status(400).json({ error: invalid });

  const id = randomUUID();

  /**
   * TWO WRITES, TWO STORES, AND NO WAY TO MAKE THEM ATOMIC.
   *
   * There is no transaction that spans Postgres and Redis. Whatever happens, this
   * process can die between these two statements, so the only real decision is
   * which order leaves the better wreckage:
   *
   *   insert then push  — crash between them leaves a 'queued' row that no worker
   *                       will ever pick up. It is in the database. One query
   *                       finds it. Something can requeue it later.
   *
   *   push then insert  — crash between them leaves a worker holding an id with no
   *                       row behind it. It cannot know what to run, cannot report
   *                       anything useful, and nothing anywhere records that a job
   *                       was ever accepted.
   *
   * An orphan you can find beats a ghost you cannot. Record the intent, then do
   * the thing — the same instinct as a database write-ahead log, which writes what
   * it is about to do before doing it precisely so a crash is recoverable.
   *
   * The orphan case is real and is not handled here; it is GAP-2.1 in
   * gaps/phase-2.md, and it closes in Phase 5 where the machinery to tell
   * "queued and waiting" from "queued and lost" already has to exist.
   */
  await query(
    db,
    `INSERT INTO jobs (id, type, payload, status) VALUES ($1, $2, $3, 'queued')`,
    [id, type, JSON.stringify(payload)],
  );

  // Only the id. The payload lives in Postgres now, and duplicating it here would
  // create a second copy that can disagree with the first.
  await redis.lpush(KEYS.pending, id);

  log.info(id, `queued (${type})`);

  return res.status(202).json({ jobId: id, status: "queued" });
});

/**
 * GET /jobs/:id
 *
 * This is the endpoint Phase 1 could not build. A job sitting inside a Redis list
 * has no address — you cannot ask a list about one entry without scanning it, and
 * once a worker popped it, it was nowhere at all. A row has a primary key, so the
 * question "what happened to this job?" now has an answer, and it keeps having one
 * long after the job finished.
 */
app.get("/jobs/:id", async (req, res) => {
  const rows = await query<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`,
    [req.params.id],
  );

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "no such job" });

  return res.json(rowToJob(row));
});

/**
 * POST /jobs/:id/replay — the dead-letter queue's exit door.
 *
 * A DLQ is an inbox, not a graveyard. Jobs land there because something was wrong
 * — a receiver was misconfigured, a payload was malformed, a downstream service
 * was down for longer than the backoff allowed. Someone reads it, fixes the cause,
 * and replays. Without this endpoint 'dead' would just mean 'discarded', and the
 * DLQ would be a table nobody could act on.
 *
 * The attempt counter resets, because the retries that were exhausted were spent
 * against the old, broken conditions. Keeping the count would mean a replayed job
 * gets zero real attempts under the fixed ones.
 */
app.post("/jobs/:id/replay", async (req, res) => {
  const { id } = req.params;

  /**
   * The status check is inside the UPDATE, not a separate SELECT-then-UPDATE.
   *
   * Two admins clicking replay at the same moment would both pass a prior SELECT,
   * and both would push the id — the job would run twice. Making the condition
   * part of the write means the second UPDATE matches zero rows, and Postgres's
   * row locking settles it.
   */
  const rows = await query<JobRow>(
    db,
    `UPDATE jobs
        SET status = 'queued', attempts = 0, last_error = NULL,
            next_run_at = NULL, started_at = NULL, completed_at = NULL
      WHERE id = $1 AND status = 'dead'
      RETURNING ${JOB_COLUMNS}`,
    [id],
  );

  const row = rows[0];
  if (!row) {
    // Either it does not exist, or it is not dead. Say which.
    const existing = await query<{ status: string }>(
      db,
      `SELECT status FROM jobs WHERE id = $1`,
      [id],
    );
    if (!existing[0]) return res.status(404).json({ error: "no such job" });
    return res.status(409).json({
      error: `only dead jobs can be replayed; this one is '${existing[0].status}'`,
    });
  }

  // Row first, then enqueue — the same ordering as POST /jobs.
  await redis.lpush(KEYS.pending, id);

  log.info(id, "replayed from the dead-letter queue");
  return res.status(202).json({ jobId: id, status: "queued" });
});

/** GET /jobs?status=&limit= — recent jobs, newest first. */
app.get("/jobs", async (req, res) => {
  const status = req.query.status as JobStatus | undefined;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const rows = status
    ? await query<JobRow>(
        db,
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, limit],
      )
    : await query<JobRow>(
        db,
        `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );

  return res.json(rows.map(rowToJob));
});

/**
 * Health of the dependencies, not of this process. Both are reported separately
 * because they fail differently and mean different things: without Redis nothing
 * can be dispatched, and without Postgres nothing can be recorded — and this API
 * refuses to accept work it cannot record.
 */
app.get("/health", async (_req, res) => {
  const health: Record<string, unknown> = { status: "ok" };

  try {
    health.redis = await redis.ping();
    health.pending = await redis.llen(KEYS.pending);
    // Jobs waiting out a backoff. Worth reporting separately from `pending`:
    // a large delayed set means things are failing, not that things are busy.
    health.delayed = await redis.zcard(KEYS.delayed);
  } catch (err) {
    health.status = "degraded";
    health.redis = err instanceof Error ? err.message : String(err);
  }

  try {
    const counts = await query<{ status: string; count: string }>(
      db,
      `SELECT status, COUNT(*)::text AS count FROM jobs GROUP BY status`,
    );
    health.postgres = "ok";
    health.jobs = Object.fromEntries(counts.map((c) => [c.status, Number(c.count)]));
  } catch (err) {
    health.status = "degraded";
    health.postgres = err instanceof Error ? err.message : String(err);
  }

  return res.status(health.status === "ok" ? 200 : 503).json(health);
});

app.listen(PORT, () => {
  log.info(null, `listening on http://localhost:${PORT}`);
});
