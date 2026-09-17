import type { JobStatus } from '../types.ts'

// One colour per lifecycle state — the CSS class names match the six statuses in
// the schema's CHECK constraint, so adding a status means adding one CSS rule.
export default function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}
