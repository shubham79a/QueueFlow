import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listJobs } from '../api/jobs.ts'
import { shortId, timeAgo } from '../format.ts'
import ReplayButton from '../components/ReplayButton.tsx'

// Jobs that ran out of attempts.
//
// There is no separate Redis list for these — the dead-letter queue is just
// `WHERE status = 'dead'`. A second copy of that fact could disagree with the row
// holding the error and the timings, so there is only the row.
export default function DlqPage() {
  const jobs = useQuery({
    queryKey: ['jobs', 'dead'],
    queryFn: () => listJobs('dead'),
    refetchInterval: 2000,
  })

  return (
    <section>
      <div className="toolbar">
        <h1>Dead-letter queue</h1>
        <span className="muted">
          jobs that exhausted their attempts. Read the error, fix the cause, replay.
        </span>
      </div>

      {jobs.isError && <p className="error">Could not load the DLQ: {jobs.error.message}</p>}

      {jobs.data && jobs.data.length === 0 && (
        <p className="muted">Nothing dead. Everything either succeeded or is still trying.</p>
      )}

      {jobs.data && jobs.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>type</th>
              <th>attempts</th>
              <th>died</th>
              <th>last error</th>
              <th />
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
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="muted">{job.completedAt ? timeAgo(job.completedAt) : ''}</td>
                <td className="mono error-cell" title={job.lastError ?? ''}>
                  {job.lastError}
                </td>
                <td>
                  <ReplayButton jobId={job.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
