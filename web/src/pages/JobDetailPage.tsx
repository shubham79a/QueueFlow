import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getJob } from '../api/jobs.ts'
import { ApiError } from '../api/client.ts'
import { duration, fmtTime, shortId, until } from '../format.ts'
import StatusBadge from '../components/StatusBadge.tsx'

// One job, everything the row holds. Polls too, so you can sit on a retrying job and
// watch attempts climb and nextRunAt move.
export default function JobDetailPage() {
  const { id = '' } = useParams()

  const job = useQuery({
    queryKey: ['job', id],
    queryFn: () => getJob(id),
    refetchInterval: 2000,
    // A 404 will not become a 200 by asking again. Anything else might.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1,
  })

  if (job.isError) {
    const notFound = job.error instanceof ApiError && job.error.status === 404
    return (
      <section>
        <BackLink />
        <p className="error">
          {notFound ? `No job with id ${id}.` : `Could not load job: ${job.error.message}`}
        </p>
      </section>
    )
  }

  if (!job.data) return <p className="muted">Loading…</p>

  const j = job.data

  return (
    <section>
      <BackLink />

      <div className="toolbar">
        <h1 className="mono">{shortId(j.id)}</h1>
        <StatusBadge status={j.status} />
        <span className="muted">{j.type}</span>
      </div>

      <dl className="kv">
        <dt>id</dt>
        <dd className="mono">{j.id}</dd>

        <dt>attempts</dt>
        <dd>
          {j.attempts} / {j.maxAttempts}
        </dd>

        <dt>created</dt>
        <dd className="mono">{fmtTime(j.createdAt)}</dd>

        <dt>started</dt>
        <dd className="mono">
          {fmtTime(j.startedAt)}
          {j.startedAt && (
            <span className="muted"> · waited {duration(j.createdAt, j.startedAt)}</span>
          )}
        </dd>

        <dt>completed</dt>
        <dd className="mono">
          {fmtTime(j.completedAt)}
          {j.completedAt && (
            <span className="muted"> · ran for {duration(j.startedAt, j.completedAt)}</span>
          )}
        </dd>

        {j.status === 'retrying' && j.nextRunAt && (
          <>
            <dt>next attempt</dt>
            <dd className="mono">
              {fmtTime(j.nextRunAt)} <span className="muted">· {until(j.nextRunAt)}</span>
            </dd>
          </>
        )}

        {j.idempotencyKey && (
          <>
            <dt>idempotency key</dt>
            <dd className="mono">{j.idempotencyKey}</dd>
          </>
        )}

        <dt>lease</dt>
        <dd className="mono muted">{j.leaseId ?? '—'}</dd>
      </dl>

      {j.lastError && (
        <>
          <h2>last error</h2>
          <pre className="error-box">{j.lastError}</pre>
        </>
      )}

      <h2>payload</h2>
      <pre className="payload">{JSON.stringify(j.payload, null, 2)}</pre>
    </section>
  )
}

function BackLink() {
  return (
    <p>
      <Link to="/">← all jobs</Link>
    </p>
  )
}
