// Shared display formatters.

// Short display form of a job ID.
export function shortId(id: string) {
  return `job_${id.slice(0, 8)}`
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

// Format an ISO timestamp as local time.
export function fmtTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false })
}

// Format elapsed time between two timestamps.
export function duration(from: string | null, to: string | null) {
  if (!from || !to) return ''
  return fmtMs(new Date(to).getTime() - new Date(from).getTime())
}

export function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// Show time remaining until a future timestamp.
export function until(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  return ms <= 0 ? 'now' : `in ${fmtMs(ms)}`
}
