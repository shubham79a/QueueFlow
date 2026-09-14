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
