// API response types used by the frontend.

// Allowed job statuses.
export const JOB_STATUSES = [
  'queued',
  'running',
  'retrying',
  'succeeded',
  'failed',
  'dead',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

// Supported job types.
export const JOB_TYPES = ['sleep', 'always_fail', 'deliver_webhook'] as const

export type JobType = (typeof JOB_TYPES)[number]

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

// Response shape for GET /api/workers.
export interface Worker {
  id: string
  alive: boolean
  // Seconds left on the heartbeat key, or null once it has expired. A worker with
  // alive:false and holding > 0 is a crash, caught before the reaper's next pass.
  expiresInSeconds: number | null
  holding: number
  jobs: string[]
}

// Response shape for GET /api/health.
export interface Health {
  status: 'ok' | 'degraded'
  redis: string // "PONG" when up, otherwise the error message
  postgres?: string // "ok" when up, otherwise the error message
  pending?: number
  delayed?: number
  jobs?: Partial<Record<JobStatus, number>>
}
