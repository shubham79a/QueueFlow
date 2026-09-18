import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listJobs } from '../api/jobs.ts'
import { JOB_STATUSES, type JobStatus } from '../types.ts'
import { duration, shortId, timeAgo } from '../format.ts'
import StatusBadge from '../components/StatusBadge.tsx'
import NewJobForm from '../components/NewJobForm.tsx'

// How often the table asks the API for fresh rows. This one number is the whole
// "live" feature — TanStack Query refetches on the interval and React re-renders
// whatever changed.
const REFRESH_MS = 2000

export default function JobsPage() {
  const [status, setStatus] = useState<JobStatus | ''>('')
  // The form lives here rather than on its own route so a new job appears in the
  // table below the moment it is created — that is the whole demo.
  const [creating, setCreating] = useState(false)

  const jobs = useQuery({
    // The status is part of the key, so switching the filter is a different query
    // with its own cache entry — flipping back shows the old rows instantly while
    // the fresh ones load.
    queryKey: ['jobs', status],
    queryFn: () => listJobs(status),
    refetchInterval: REFRESH_MS,
  })

  return (
    <section>
      <div className="toolbar">
        <h1>Jobs</h1>
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>
            New job
          </button>
        )}
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

      {creating && <NewJobForm onDone={() => setCreating(false)} />}

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
                <td className="mono">
                  <Link to={`/jobs/${job.id}`}>{shortId(job.id)}</Link>
                </td>
                <td>{job.type}</td>
                <td>
                  <StatusBadge status={job.status} />
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
