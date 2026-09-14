import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listJobs } from '../api/jobs.ts'
import { JOB_STATUSES, type JobStatus } from '../types.ts'

// How often the table asks the API for fresh rows. This one number is the whole
// "live" feature — TanStack Query refetches on the interval and React re-renders
// whatever changed.
const REFRESH_MS = 2000

export default function JobsPage() {
  const [status, setStatus] = useState<JobStatus | ''>('')

  const jobs = useQuery({
    // The status is part of the key, so switching the filter is a different query
    // with its own cache entry — flipping back shows the old rows instantly while
    // the fresh ones load.
    queryKey: ['jobs', status],
    queryFn: () => listJobs(status),
    refetchInterval: REFRESH_MS,
  })

  console.log("jobs",jobs)

  return (
    <section>
      <div className="toolbar">
        <h1>Jobs</h1>
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | '')}>
            <option value="">all</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {jobs.isFetching ? 'refreshing…' : `refreshes every ${REFRESH_MS / 1000}s`}
        </span>
      </div>

      {jobs.isError && <p className="error">Could not load jobs: {jobs.error.message}</p>}

      {jobs.data && jobs.data.length === 0 && (
        <p className="muted">No jobs{status ? ` with status "${status}"` : ''} yet.</p>
      )}

      {jobs.data && jobs.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>type</th>
              <th>status</th>
              <th>attempts</th>
              <th>created</th>
              <th>waited</th>
              <th>ran for</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data.map((job) => (
              <tr key={job.id}>
                <td className="mono">{shortId(job.id)}</td>
                <td>{job.type}</td>
                <td>
                  <span className={`badge badge-${job.status}`}>{job.status}</span>
                </td>
                <td>
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="muted">{timeAgo(job.createdAt)}</td>
                <td className="mono">{duration(job.createdAt, job.startedAt)}</td>
                <td className="mono">{duration(job.startedAt, job.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// Same shape the worker logs use, so an id on screen matches the id in a terminal.
function shortId(id: string) {
  return `job_${id.slice(0, 8)}`
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

// The two columns the schema comment calls out: created→started is how long the
// queue made the job wait (measures us); started→completed is how long the work
// took (measures the handler). Blank until the later timestamp exists.
function duration(from: string | null, to: string | null) {
  if (!from || !to) return ''
  const ms = new Date(to).getTime() - new Date(from).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
