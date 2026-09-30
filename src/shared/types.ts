export const JOB_TYPES = ["sleep", "always_fail", "deliver_webhook"] as const;

export type JobType = (typeof JOB_TYPES)[number];

// Maps each job type to the payload it expects.
export interface JobPayloads {
  sleep: { ms: number };
  /** A test fixture: throws so the failed path and last_error are reachable. */
  always_fail: { message?: string };
  /** POST `body` as JSON to `url`. Fails on timeout, refusal, or any non-2xx. */
  deliver_webhook: { url: string; body?: unknown; timeoutMs?: number };
}

/** The lifecycle. Mirrors the CHECK constraint in db/schema.sql — keep them in step. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "dead",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

// A row from the jobs table, already mapped out of snake_case.
// The difference is not cosmetic: a Job used to be something the API invented and put on a queue, 
// and it is now a row that exists whether or not anything is currently holding it.
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
  // When a 'retrying' job becomes due. NULL for every other status.
  nextRunAt: Date | null;
  // Who currently has the right to speak for this job. Rewritten on every claim;
  // a worker whose copy no longer matches has been fenced out and must not write.
  leaseId: string | null;
}

// Exactly the column set every SELECT in this project uses.
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
  next_run_at: Date | null;
  lease_id: string | null;
}

// snake_case -> camelCase, in one place.
// Worth doing here rather than at each call site so that the database's naming
// convention stops at this function instead of leaking through the whole codebase.

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
    nextRunAt: row.next_run_at,
    leaseId: row.lease_id,
  };
}

// Postgress stores the data and all details, history and it is source of truth.
// Redis stores only UUIDs, and fetch data from Postgres.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

/**
 * Whether a webhook may target private and loopback addresses.
 *
 * OFF BY DEFAULT, because the safe default is the one that holds when somebody deploys
 * this without reading anything. Local development needs it on — the test receiver runs
 * on 127.0.0.1:4001 and the whole webhook demo depends on reaching it — so .env sets it
 * and no deployment does.
 */
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "true";

/**
 * Server-side request forgery, and why a webhook sender is the natural place for it.
 *
 * deliver_webhook makes THE SERVER issue a request to a URL THE CALLER chose. Without a
 * restriction that is a general-purpose proxy into wherever the server can reach, which
 * on a hosted deployment includes things nothing outside should touch:
 *
 *   169.254.169.254   the cloud metadata endpoint — instance credentials on some hosts
 *   127.0.0.1         the API's own port, from inside its own trust boundary
 *   10.x / 172.16-31.x / 192.168.x   whatever else shares the private network
 *
 * Auth limits who can ask, and that is not the same as limiting what may be asked for.
 *
 * WHAT THIS DOES NOT STOP, stated plainly rather than implied: the check is on the
 * hostname as written, so a public name that RESOLVES to a private address walks
 * straight through it. Closing that means resolving the host here and re-checking the
 * resolved address at connect time, because DNS can answer differently between the two.
 * That is a real piece of work and it is written down as a gap rather than half-done —
 * this blocks the literal cases, which is every accidental one and most deliberate ones.
 */
function blockedTarget(host: string): string | null {
  if (ALLOW_PRIVATE_TARGETS) return null;

  const h = host.toLowerCase().replace(/^\[|]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return "loopback";
  }

  // IPv6 loopback and link-local.
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return "private IPv6";
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return null;

  const [a, b] = [Number(v4[1]), Number(v4[2])];

  if (a === 127 || a === 0) return "loopback";
  if (a === 10) return "private network";
  if (a === 192 && b === 168) return "private network";
  if (a === 172 && b >= 16 && b <= 31) return "private network";
  // The one that matters most on a cloud host: instance metadata.
  if (a === 169 && b === 254) return "link-local / cloud metadata";

  return null;
}

// Validates a payload at the API boundary, where it arrives from outside.
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

    const blocked = blockedTarget(parsed.hostname);
    if (blocked) {
      return `deliver_webhook payload.url points at a ${blocked} address, which this server will not call`;
    }

    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || p.timeoutMs <= 0)) {
      return "deliver_webhook payload.timeoutMs must be a positive number";
    }
  }

  return null;
}
