import { apiFetch } from './client.ts'
import type { Job, JobStatus, JobType } from '../types.ts'

// Every call the UI makes about jobs, in one file. Pages import these by name and
// never build a URL themselves — so when an endpoint changes, it changes here once.

export interface JobPage {
  jobs: Job[]
  // Opaque — base64 of the last row's (created_at, id). Pass it back to get the next
  // page; null means there is no next page. Never parse it: the server is free to
  // change what is inside, and nothing here should depend on the shape.
  nextCursor: string | null
}

export function listJobs(
  status: JobStatus | '' = '',
  cursor?: string,
  limit = 50,
): Promise<JobPage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) params.set('status', status)
  if (cursor) params.set('cursor', cursor)
  return apiFetch<JobPage>(`/jobs?${params}`)
}

// 404 surfaces as an ApiError with status 404 — the detail page checks for that
// specifically so a bad link reads "no such job" rather than a generic failure.
export function getJob(id: string): Promise<Job> {
  return apiFetch<Job>(`/jobs/${id}`)
}

export interface CreatedJob {
  jobId: string
  status: string
  // Present and true when an Idempotency-Key matched an existing job: nothing new
  // was created and this is the original.
  deduplicated?: boolean
}

// Needs a write proof — the session cookie rides along via apiFetch. 401 signed out.
export function createJob(
  type: JobType,
  payload: unknown,
  idempotencyKey?: string,
): Promise<CreatedJob> {
  return apiFetch<CreatedJob>('/jobs', {
    method: 'POST',
    body: JSON.stringify({ type, payload }),
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  })
}

// 409 when the job is not dead — only dead jobs can be replayed.
export function replayJob(id: string): Promise<CreatedJob> {
  return apiFetch<CreatedJob>(`/jobs/${id}/replay`, { method: 'POST' })
}
