import type { Health } from '../types.ts'

// 503 is a valid health response, so preserve its diagnostic body.
export async function getHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (res.status !== 200 && res.status !== 503) {
    throw new Error(`health check failed: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<Health>
}
