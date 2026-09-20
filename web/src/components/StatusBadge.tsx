import type { JobStatus } from '@/types'

// One colour per lifecycle state — the same six as the CHECK constraint in
// db/schema.sql. The colours are tokens defined per theme in index.css rather than
// utilities here, so a status cannot end up legible in light mode and not in dark.
const TONE: Record<JobStatus, string> = {
  queued: 'bg-status-queued text-status-queued-fg',
  running: 'bg-status-running text-status-running-fg',
  retrying: 'bg-status-retrying text-status-retrying-fg',
  succeeded: 'bg-status-succeeded text-status-succeeded-fg',
  failed: 'bg-status-failed text-status-failed-fg',
  dead: 'bg-status-dead text-status-dead-fg',
}

export default function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}
    >
      {/* `running` is the only state that is actively happening, so it is the only one
          that moves. Everything else is a resting state. */}
      {status === 'running' && (
        <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </span>
  )
}
