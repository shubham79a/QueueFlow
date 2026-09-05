/**
 * The shape of a job, on both sides of the two stores it now lives in.
 */

/** Job types this system knows how to run. */
export const JOB_TYPES = ["sleep", "always_fail", "deliver_webhook"] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** Maps each job type to the payload it expects. */
export interface JobPayloads {
  sleep: { ms: number };
  /** A test fixture: throws so the failed path and last_error are reachable. */
  always_fail: { message?: string };
  /** POST `body` as JSON to `url`. Fails on timeout, refusal, or any non-2xx. */
  deliver_webhook: { url: string; body?: unknown; timeoutMs?: number };
}

/** The lifecycle. Mirrors the CHECK constraint in db/schema.sql — keep them in step. */
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * A row from the jobs table, already mapped out of snake_case.
 *
 * This replaces Phase 1's `Job`. The difference is not cosmetic: a Job used to be
 * something the API invented and put on a queue, and it is now a row that exists
 * whether or not anything is currently holding it.
 */
export interface JobRecord<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Exactly the column set every SELECT in this project uses. */
export interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

/**
 * snake_case -> camelCase, in one place.
 *
 * Worth doing here rather than at each call site so that the database's naming
 * convention stops at this function instead of leaking through the whole codebase.
 */
export function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type as JobType,
    payload: row.payload as JobPayloads[JobType],
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * The trust boundary moved, it did not disappear.
 *
 * In Phase 1 the worker pulled a whole JSON job out of Redis and had to validate
 * all of it. Now Redis carries a bare UUID and the payload comes from Postgres —
 * which this system wrote itself, after validating it at the API. So the check
 * that used to be `parseJob` shrinks to this: is the thing that came off the queue
 * even shaped like an id?
 *
 * It still has to exist. What comes back from BRPOP is a `string`, and TypeScript
 * cannot vouch for a string that arrived over a socket from another process.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

/** Validates a payload at the API boundary, where it arrives from outside. */
export function validatePayload(type: JobType, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return "payload must be an object";

  if (type === "sleep") {
    const ms = (payload as Record<string, unknown>).ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      return "sleep requires payload.ms (a non-negative number)";
    }
  }

  if (type === "deliver_webhook") {
    const p = payload as Record<string, unknown>;
    if (typeof p.url !== "string") return "deliver_webhook requires payload.url";

    // Parsed here, at the edge, rather than left for fetch() to throw on inside
    // the worker. A malformed URL is a bad request — the caller can fix it and
    // should be told immediately — not a job that gets accepted, queued, run and
    // then marked failed several seconds later.
    let parsed: URL;
    try {
      parsed = new URL(p.url);
    } catch {
      return "deliver_webhook payload.url is not a valid URL";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "deliver_webhook payload.url must be http or https";
    }

    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || p.timeoutMs <= 0)) {
      return "deliver_webhook payload.timeoutMs must be a positive number";
    }
  }

  return null;
}
