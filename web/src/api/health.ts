import type { Health } from '../types.ts'

// Not through apiFetch, on purpose.
//
// /api/health answers 503 when a dependency is down — and that is a valid, useful
// answer, not a failed request. apiFetch throws on any non-2xx and would discard the
// body, which is exactly the part that says what broke. So this reads the JSON on
// both 200 and 503 and only throws if the API itself is unreachable.
export async function getHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (res.status !== 200 && res.status !== 503) {
    throw new Error(`health check failed: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<Health>
}
