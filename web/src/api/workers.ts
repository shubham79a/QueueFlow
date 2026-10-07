import { apiFetch } from './client.ts'
import type { Worker } from '../types.ts'

// Fetch current worker state.
export function listWorkers(): Promise<Worker[]> {
  return apiFetch<{ workers: Worker[] }>('/workers').then((r) => r.workers)
}
