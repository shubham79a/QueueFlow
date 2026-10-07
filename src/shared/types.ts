export const JOB_TYPES = ["sleep", "always_fail", "deliver_webhook"] as const;

export type JobType = (typeof JOB_TYPES)[number];

// Maps each job type to the payload shape it expects.
export interface JobPayloads {
  sleep: { ms: number };
  // Test job that always throws, so failure and retry paths can be exercised.
  always_fail: { message?: string };
  // Sends the body as JSON to the target URL. Fails on timeout, connection errors, or non-2xx responses.
  deliver_webhook: { url: string; body?: unknown; timeoutMs?: number };
}

// Job lifecycle states. Must stay in sync with the DB CHECK constraint.
export const JOB_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "dead",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

// Application-level job record with database fields mapped to camelCase.
// The job exists in Postgres even when Redis is not currently holding its ID.
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
  // Current ownership token. A stale worker with an old lease cannot update the job.
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

// Convert the database row from snake_case to the application's camelCase model.
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

// Postgres is the durable source of truth; Redis carries only job IDs for transport.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

// Allow private webhook targets only when explicitly enabled, mainly for local testing.
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "true";

// Block obvious private and loopback targets to reduce SSRF risk.
// The webhook worker makes server-side requests to caller-provided URLs, so
// without this check it could be used to reach services inside the server's network.
// This checks the hostname as written; DNS names that later resolve to private
// addresses are not covered by this check.
function blockedTarget(host: string): string | null {
  if (ALLOW_PRIVATE_TARGETS) return null;

  const h = host.toLowerCase().replace(/^\[|]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return "loopback";
  }

  // Block IPv6 loopback, link-local, and private ranges.
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

    // Validate the URL here so malformed input is rejected immediately instead of
    // becoming a queued job that fails later in the worker.
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
