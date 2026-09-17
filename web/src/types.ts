// The shapes the API returns, as the browser sees them.
//
// Mirrors JobRecord in ../src/shared/types.ts on purpose rather than importing it —
// web/ and src/ are separate packages with separate builds, and over JSON every Date
// is a string anyway. If a field is added to the API, add it here too.

export const JOB_STATUSES = [
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'dead',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

export interface Job {
  id: string
  type: string
  payload: unknown
  status: JobStatus
  attempts: number
  maxAttempts: number
  lastError: string | null
  idempotencyKey: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  nextRunAt: string | null
  leaseId: string | null
}

// One row of GET /api/workers. Assembled from Redis alone — the heartbeat key and
// the processing list are a worker's entire public presence.
export interface Worker {
  id: string
  alive: boolean
  // Seconds left on the heartbeat key, or null once it has expired. A worker with
  // alive:false and holding > 0 is a crash, caught before the reaper's next pass.
  expiresInSeconds: number | null
  holding: number
  jobs: string[]
}

// GET /api/health. Answers 503 when degraded, and the body is still meaningful — the
// fields below are optional because whichever dependency failed will be missing its
// numbers and carry an error string instead.
export interface Health {
  status: 'ok' | 'degraded'
  redis: string // "PONG" when up, otherwise the error message
  postgres?: string // "ok" when up, otherwise the error message
  pending?: number
  delayed?: number
  jobs?: Partial<Record<JobStatus, number>>
}
