import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  BadRequest, decodeCursor, encodeCursor, parseLimit, parseStatus,
} from "./params.js";
import {
  KEYS, scanKeys, workerIdFromAliveKey, workerIdFromProcessingKey,
} from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { createDb, query } from "../shared/db.js";
import { onShutdown } from "../shared/shutdown.js";
import {
  AUTH_DISABLED, KEYS_CONFIGURED, LOGIN_ENABLED, SESSION_SECRET_SET, clearFailures, clearSessionCookie,
  hasSession, isCorrectPassword, isThrottled, recordFailure, requireWrite, setSessionCookie,
} from "./auth.js";
import { isJobType, rowToJob, validatePayload, type JobRow } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 4000);

const log = createLogger("api");
const redis = createRedis("api", log);
const db = createDb("api", log);

const app = express();

// Trust the reverse proxy when configured so Express can detect HTTPS.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
}

app.use(express.json());

// JSON API routes mounted under /api.
const api = express.Router();

const JOB_COLUMNS = `id, type, payload, status, attempts, max_attempts,
                     last_error, idempotency_key, created_at, started_at, completed_at,
                     next_run_at, lease_id`;

// POST /jobs — create and enqueue a job.
api.post("/jobs", requireWrite, async (req, res) => {
  const { type, payload } = req.body ?? {};

  if (!isJobType(type)) {
    return res.status(400).json({ error: `unknown job type: ${String(type)}` });
  }

  const invalid = validatePayload(type, payload);
  if (invalid) return res.status(400).json({ error: invalid });

  // Optional key supplied by the caller for duplicate request protection.
  const idempotencyKey = req.get("Idempotency-Key") ?? null;

  const id = randomUUID();

  // Insert into Postgres first so every queued job has a durable record.
  const inserted = await query<JobRow>(
    db,
    `INSERT INTO jobs (id, type, payload, status, idempotency_key)
          VALUES ($1, $2, $3, 'queued', $4)
     ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
    [id, type, JSON.stringify(payload), idempotencyKey],
  );

  // Return the existing job when the idempotency key was already used.
  if (!inserted[0]) {
    const existing = await query<JobRow>(
      db,
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );

    const first = existing[0];

    if (!first) return res.status(409).json({ error: "idempotency key is in use" });

    log.info(first.id, `duplicate submission (key ${idempotencyKey}) — returning the original`);

    return res.status(200).json({
      jobId: first.id,
      status: first.status,
      deduplicated: true,
    });
  }

  // Redis stores only the job ID; Postgres remains the source of truth.
  await redis.lpush(KEYS.pending, id);

  log.info(id, `queued (${type})`);

  return res.status(202).json({ jobId: id, status: "queued" });
});

// GET /jobs/:id — return a job from Postgres.
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

// POST /jobs/:id/replay — requeue a dead job.
api.post<{ id: string }>("/jobs/:id/replay", requireWrite, async (req, res) => {
  const { id } = req.params;

  // Atomically change only dead jobs to prevent duplicate replays.
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
    // Distinguish a missing job from a job that is not dead.
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

  // Requeue the job after resetting its state.
  await redis.lpush(KEYS.pending, id);

  log.info(id, "replayed from the dead-letter queue");

  return res.status(202).json({ jobId: id, status: "queued" });
});

// GET /jobs?status=&limit= — return recent jobs using keyset pagination.
api.get("/jobs", async (req, res) => {
  const status = parseStatus(req.query.status);
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);

  // Use keyset pagination instead of OFFSET for a changing queue.
  const where: string[] = [];
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  if (cursor) {
    params.push(cursor.t, cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  // Fetch one extra row to determine whether another page exists.
  params.push(limit + 1);

  const rows = await query<JobRow>(
    db,
    `SELECT ${JOB_COLUMNS} FROM jobs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return res.json({
    jobs: page.map(rowToJob),
    nextCursor:
      hasMore && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null,
  });
});

// GET /workers — return workers discovered through Redis.
api.get("/workers", async (_req, res) => {
  const ids = new Set<string>();

  // Combine heartbeat and processing keys to find active and stranded workers.
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
      // Positive TTL means the worker heartbeat is still alive.
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

// Check Redis and Postgres health separately.
api.get("/health", async (_req, res) => {
  const health: Record<string, unknown> = { status: "ok" };

  try {
    health.redis = await redis.ping();
    health.pending = await redis.llen(KEYS.pending);

    // Report delayed jobs separately from ready jobs.
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

// --------------------------------------------------------------------------
// Operator login.
// --------------------------------------------------------------------------

api.post("/auth/login", (req, res) => {
  const ip = req.ip ?? "unknown";

  if (isThrottled(ip)) {
    return res.status(429).json({ error: "too many attempts — wait 15 minutes" });
  }

  const { password } = (req.body ?? {}) as { password?: unknown };

  if (typeof password !== "string" || !isCorrectPassword(password)) {
    // Count failed attempts before returning the error.
    recordFailure(ip);

    log.error(null, `failed login attempt from ${ip}`);

    return res.status(401).json({ error: "wrong password" });
  }

  clearFailures(ip);

  setSessionCookie(req, res);

  log.info(null, `operator signed in from ${ip}`);

  return res.json({ ok: true });
});

api.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);

  return res.json({ ok: true });
});

// Return the authentication state used by the dashboard.
api.get("/auth/me", (req, res) => {
  return res.json({
    authenticated: hasSession(req),
    loginEnabled: LOGIN_ENABLED,
    writeOpen: AUTH_DISABLED,
  });
});

// Return JSON for unknown API routes.
api.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Convert known client errors to 400 and hide unexpected details.
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message });
  }

  log.error(null, `unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);

  return res.status(500).json({ error: "internal error" });
});

app.use("/api", api);

// Serve the built dashboard when available.
const webDist = resolve(import.meta.dirname, "../../web/dist");
const webIndex = join(webDist, "index.html");

if (existsSync(webIndex)) {
  app.use(express.static(webDist));

  // SPA fallback for client-side routes.
  app.use((_req, res) => {
    res.sendFile(webIndex);
  });

  log.info(null, `serving dashboard from ${webDist}`);
}

const server = app.listen(PORT, () => {
  log.info(null, `listening on http://localhost:${PORT}`);

  // Warn when write routes are deployed without authentication.
  if (AUTH_DISABLED) {
    log.error(
      null,
      "neither API_KEYS nor ADMIN_PASSWORD is set — job submission and replay are" +
      " UNAUTHENTICATED. Generate a value with `npm run key:new` before deploying.",
    );
  } else {
    log.info(
      null,
      `write access: ${KEYS_CONFIGURED ? "API key" : "no key"}` +
      ` / ${LOGIN_ENABLED ? "operator login" : "no login"}`,
    );
  }

  // Warn when sessions use a generated secret that changes on restart.
  if (LOGIN_ENABLED && !SESSION_SECRET_SET) {
    log.error(
      null,
      "SESSION_SECRET is not set — logins will not survive a restart." +
      " Generate one with `npm run key:new`.",
    );
  }
});

// Gracefully close HTTP, Redis, and Postgres resources.
onShutdown(log, async () => {
  // Stop accepting new connections and close idle keep-alive sockets.
  server.closeIdleConnections();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  await redis.quit().catch(() => redis.disconnect());
  await db.end().catch(() => undefined);
});