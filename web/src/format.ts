// Small formatters shared by every page. Kept out of the components so the same id
// or duration reads the same everywhere on screen.

// Same shape the worker logs use, so an id on screen matches an id in a terminal.
export function shortId(id: string) {
  return `job_${id.slice(0, 8)}`
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

// Local time, to the second. The date is dropped — everything on a dashboard
// happened recently, and the column is narrow.
export function fmtTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false })
}

// The two derived columns from the schema comment: created→started is how long the
// queue made the job wait (measures us); started→completed is how long the work took
// (measures the handler). Blank until the later timestamp exists.
export function duration(from: string | null, to: string | null) {
  if (!from || !to) return ''
  return fmtMs(new Date(to).getTime() - new Date(from).getTime())
}

export function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// How far in the future a timestamp is — for a retrying job's nextRunAt.
export function until(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  return ms <= 0 ? 'now' : `in ${fmtMs(ms)}`
}
