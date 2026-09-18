import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express from "express";
import {
  KEYS,
  scanKeys,
  workerIdFromAliveKey,
  workerIdFromProcessingKey,
} from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { AUTH_DISABLED, requireWrite } from "./auth.js";
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

// Every JSON route lives on this router, mounted at /api. The prefix exists because the
// dashboard is served from the same process at `/` — without it, GET /jobs would have to
// be both the JSON list and the page that shows it.
const api = express.Router();

const JOB_COLUMNS = `id, type, payload, status, attempts, max_attempts,
                     last_error, idempotency_key, created_at, started_at, completed_at,
                     next_run_at, lease_id`;

// POST /jobs — the producer.
// The handler still does not run the job, wait for it, or ever learn whether it succeeded.

api.post("/jobs", requireWrite, async (req, res) => {
  const { type, payload } = req.body ?? {};

  if (!isJobType(type)) {
    return res.status(400).json({ error: `unknown job type: ${String(type)}` });
  }
  const invalid = validatePayload(type, payload);
  if (invalid) return res.status(400).json({ error: invalid });

  // Optional, and supplied by the CALLER — which is the only place it can come
  // from. The caller is the only party that knows two of its requests mean the
  // same thing; nothing observable about the second request distinguishes it from
  // a legitimate second order for the same amount to the same address.

  // The header spelling is the one Stripe popularised and most APIs now copy.
  // NULL when absent, and NULLs do not collide in a UNIQUE index, so callers that
  // do not send one keep the old behaviour exactly: every POST is a new job.

  const idempotencyKey = req.get("Idempotency-Key") ?? null;

  const id = randomUUID();

  // TWO WRITES, TWO STORES, AND NO WAY TO MAKE THEM ATOMIC. Redis and Postgress
  // There is no transaction that spans Postgres and Redis. Whatever happens, this process can die between 
  // these two statements, so the only real decision is which order leaves the better wreckage:
  //  insert then push  — crash between them leaves a 'queued' row that no worker
  //     (Orphan)         will ever pick up. It is in the DB. One query finds it and can requeue it later.
  //  push then insert  — crash between them leaves a worker holding an id with no
  //     (Ghost)          row behind it. It cannot know what to run, cannot report anything useful. No DB Record.

  const inserted = await query<JobRow>(
    db,
    `INSERT INTO jobs (id, type, payload, status, idempotency_key)
          VALUES ($1, $2, $3, 'queued', $4)
     ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
    [id, type, JSON.stringify(payload), idempotencyKey],
  );


  // Idempotency check — NOTHING INSERTED means the key has been used before — this is a repeat of a request that
  // already succeeded, and the honest answer is the job that request created, not a second job doing the same work.
  // Lease: used when an worker dies and lease id help you to avoid commit to db by comparing lease id stored in db.

  // Issue: client submitting same task twice, but the first submission was lost due to network issues. The client retries,
  // and without this check, it would create a duplicate job. The UNIQUE constraint on the idempotency key ensures that only
  // one job is created for the same key.

  // The check is the INSERT itself rather than a SELECT beforehand, for the same reason the replay endpoint below
  // puts its condition inside the UPDATE: two simultaneous requests would both pass a prior SELECT and both insert. 
  // Here the UNIQUE constraint decides, and it is the database's job to decide. 200, not 202 — nothing was 
  // accepted this time, and the caller should be able to tell those apart.

  if (!inserted[0]) {
    const existing = await query<JobRow>(
      db,
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const first = existing[0];

    // Only reachable if the row was deleted between the two statements, which
    // nothing in this system does. Say something useful rather than crash.
    if (!first) return res.status(409).json({ error: "idempotency key is in use" });

    log.info(first.id, `duplicate submission (key ${idempotencyKey}) — returning the original`);

    return res.status(200).json({
      jobId: first.id,
      status: first.status,
      deduplicated: true,
    });
  }

  // Only the id. The payload lives in Postgres now, and duplicating it here would create a second copy that can disagree with the first.
  await redis.lpush(KEYS.pending, id);

  log.info(id, `queued (${type})`);

  return res.status(202).json({ jobId: id, status: "queued" });
});

// GET /jobs/:id — the consumer, or anyone else who wants to know what happened to a job.

api.get("/jobs/:id", async (req, res) => {
  const rows = await query<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`,
    [req.params.id],
  );

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "no such job" });

  return res.json(rowToJob(row));
});

// POST /jobs/:id/replay — the dead-letter queue's exit door.

// DLQ = Dead Letter Queue. Dead jobs who exhausted their attempts need human intervention to fix the cause of failure.
// Attempt counter resets with new conditions, because the retries that were exhausted were spent against the old, broken conditions.

// The <{ id: string }> is not decoration: with a middleware in the chain, Express's
// overloads stop inferring the route's params and `id` widens to string | string[].
api.post<{ id: string }>("/jobs/:id/replay", requireWrite, async (req, res) => {
  const { id } = req.params;
  // update is atomic, so no need to check if the job is dead first. If it is not, the update will return 0 rows and we can handle that case.
  // seprate? why not?

  // Two admins clicking replay at the same moment would both pass a prior SELECT, and both would push the id — the job would run twice.
  // Making the condition part of the write means the second UPDATE matches zero rows, and Postgres's row locking settles it.

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

// GET /jobs?status=&limit= — recent jobs, newest first. 
api.get("/jobs", async (req, res) => {
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
 * GET /workers — who is out there, and what is each of them holding.
 *
 * Assembled entirely from Redis, never from anything this process knows locally.
 * That is deliberate: the API has no connection to any worker and no idea how many
 * exist, so a worker on another machine shows up here exactly like one running in
 * the next terminal. The heartbeat key and the processing list ARE the worker's
 * public presence; there is nothing else to ask.
 *
 * THE INTERESTING ROW IS `alive: false` WITH `holding` ABOVE ZERO. That is a
 * worker that stopped talking while holding work — a crash, caught in the window
 * between its heartbeat expiring and the reaper's next pass. Kill a worker mid-job
 * and refresh this endpoint to watch it: first the TTL counts down, then `alive`
 * flips to false while the jobs are still listed against it, then the jobs move
 * back to pending and the row disappears.
 */
api.get("/workers", async (_req, res) => {
  const ids = new Set<string>();

  // Two sources, because they answer different questions. A heartbeat with no
  // processing list is an idle worker; a processing list with no heartbeat is a
  // dead one. Both are workers, and only the union finds them all.
  for (const key of await scanKeys(redis, KEYS.alivePattern)) {
    const id = workerIdFromAliveKey(key);
    if (id !== null) ids.add(id);
  }
  for (const key of await scanKeys(redis, KEYS.processingPattern)) {
    const id = workerIdFromProcessingKey(key);
    if (id !== null) ids.add(id);
  }

  const workers = await Promise.all(
    [...ids].sort().map(async (id) => {
      // TTL returns -2 when the key is gone and -1 when it exists without an
      // expiry. Only a positive number means "alive, and here is how long it has
      // left before anything watching gives up on it".
      const ttl = await redis.ttl(KEYS.alive(id));
      const holding = await redis.lrange(KEYS.processing(id), 0, -1);

      return {
        id,
        alive: ttl > 0,
        expiresInSeconds: ttl > 0 ? ttl : null,
        holding: holding.length,
        jobs: holding,
      };
    }),
  );

  return res.json({ workers });
});

// Health of the dependencies, not of this process. Both are reported separately because they fail differently and mean
// different things: without Redis nothing can be dispatched, and without Postgres nothing can be recorded — and
// this API refuses to accept work it cannot record.

api.get("/health", async (_req, res) => {
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

// Last handler on the router: an unknown /api/* path is a JSON 404. Without this it
// would fall through to the dashboard fallback below and come back as HTML.
api.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use("/api", api);

// The dashboard. `web/` builds to static files; if they exist, this process serves
// them at `/` — one port, one deployable. If they don't (dev, or a fresh clone with no
// build yet), skip entirely and the API runs as it always has; Vite serves the UI on
// its own port and proxies /api here.
//
// The final `app.use` is the SPA fallback: a browser reload on /jobs/abc must get
// index.html, not a 404, so the client-side router can take over. Anything under /api
// never reaches it — the router's own 404 above catches that first.
const webDist = resolve(import.meta.dirname, "../../web/dist");
const webIndex = join(webDist, "index.html");

if (existsSync(webIndex)) {
  app.use(express.static(webDist));
  app.use((_req, res) => {
    res.sendFile(webIndex);
  });
  log.info(null, `serving dashboard from ${webDist}`);
}

app.listen(PORT, () => {
  log.info(null, `listening on http://localhost:${PORT}`);

  // Open write routes are fine locally and wrong anywhere else. Say so rather than
  // letting a deploy be quietly unauthenticated.
  if (AUTH_DISABLED) {
    log.error(
      null,
      "API_KEYS is not set — job submission and replay are UNAUTHENTICATED." +
        " Generate one with `npm run key:new` before deploying.",
    );
  }
});
