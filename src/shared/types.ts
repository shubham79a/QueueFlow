/**
 * The shape of a job, and — more importantly — the runtime check that a thing
 * pulled out of Redis actually IS one.
 */

/** Job types this system knows how to run. Phase 1 has exactly one. */
export const JOB_TYPES = ["sleep"] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** Maps each job type to the payload it expects. */
export interface JobPayloads {
  sleep: { ms: number };
}

export interface Job<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  /** ISO 8601. When the API accepted it — not when a worker started it. */
  createdAt: string;
}

/**
 * Why this function exists, and why a TypeScript `interface` was not enough:
 *
 * Types are erased at compile time. They do not exist when the program runs.
 * What the worker actually receives from Redis is a `string` — bytes that left
 * another process, sat in a database, and came back. TypeScript cannot vouch for
 * any of it. Writing `JSON.parse(raw) as Job` is a lie you tell the compiler; it
 * checks nothing and turns a bad payload into a crash somewhere further away.
 *
 * So the boundary gets a real, runtime check. Everything past this function is
 * genuinely a Job; everything before it is an untrusted string.
 *
 * Returns null rather than throwing: a malformed entry is bad data, not a bug in
 * the worker, and the worker's response to it is to log and carry on — not to die.
 */
export function parseJob(raw: string): Job | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const job = value as Record<string, unknown>;

  if (typeof job.id !== "string" || job.id.length === 0) return null;
  if (typeof job.createdAt !== "string") return null;
  if (!isJobType(job.type)) return null;
  if (typeof job.payload !== "object" || job.payload === null) return null;

  if (job.type === "sleep") {
    const ms = (job.payload as Record<string, unknown>).ms;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  }

  return job as unknown as Job;
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}
