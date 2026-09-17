import { apiFetch } from './client.ts'
import type { Job, JobStatus } from '../types.ts'

// Every call the UI makes about jobs, in one file. Pages import these by name and
// never build a URL themselves — so when an endpoint changes, it changes here once.

export function listJobs(status: JobStatus | '' = '', limit = 50): Promise<Job[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) params.set('status', status)
  return apiFetch<Job[]>(`/jobs?${params}`)
}

// 404 surfaces as an ApiError with status 404 — the detail page checks for that
// specifically so a bad link reads "no such job" rather than a generic failure.
export function getJob(id: string): Promise<Job> {
  return apiFetch<Job>(`/jobs/${id}`)
}
