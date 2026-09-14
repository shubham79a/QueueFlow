import { apiFetch } from './client.ts'
import type { Job, JobStatus } from '../types.ts'

// Every call the UI makes about jobs, in one file. Pages import these by name and
// never build a URL themselves — so when an endpoint changes, it changes here once.
//
// Grows with the features: getJob, replayJob and createJob land in 2, 5 and 5.

export function listJobs(status: JobStatus | '' = '', limit = 50): Promise<Job[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status) params.set('status', status)
  return apiFetch<Job[]>(`/jobs?${params}`)
}
