import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listWorkers } from '../api/workers.ts'
import { shortId } from '../format.ts'

// One second, not two: the heartbeat TTL counting down is the whole point of this
// page, and a 2 s poll would make it skip.
const REFRESH_MS = 1000

export default function WorkersPage() {
  const workers = useQuery({
    queryKey: ['workers'],
    queryFn: listWorkers,
    refetchInterval: REFRESH_MS,
  })

  return (
    <section>
      <div className="toolbar">
        <h1>Workers</h1>
        <span className="muted">
          from Redis alone — heartbeat keys and processing lists. Refreshes every second.
        </span>
      </div>

      {workers.isError && (
        <p className="error">Could not load workers: {workers.error.message}</p>
      )}

      {workers.data && workers.data.length === 0 && (
        <p className="muted">No workers running. Start one with <code>npm run dev:worker</code>.</p>
      )}

      {workers.data && workers.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>worker</th>
              <th>status</th>
              <th>heartbeat</th>
              <th>holding</th>
              <th>jobs</th>
            </tr>
          </thead>
          <tbody>
            {workers.data.map((w) => {
              // The row this page exists for: the heartbeat has lapsed but the
              // processing list is not empty. That is a crashed worker, seen in the
              // window between its key expiring and the reaper's next pass.
              const stranded = !w.alive && w.holding > 0

              return (
                <tr key={w.id} className={stranded ? 'row-warn' : undefined}>
                  <td className="mono">{w.id}</td>
                  <td>
                    <span className={`badge ${w.alive ? 'badge-succeeded' : 'badge-dead'}`}>
                      {w.alive ? 'alive' : 'gone'}
                    </span>
                  </td>
                  <td className="mono">
                    {w.expiresInSeconds !== null ? `${w.expiresInSeconds}s left` : '—'}
                  </td>
                  <td>
                    {w.holding}
                    {stranded && (
                      <span className="muted"> — stopped responding; the reaper will return these</span>
                    )}
                  </td>
                  <td className="mono">
                    {w.jobs.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ', '}
                        <Link to={`/jobs/${id}`}>{shortId(id)}</Link>
                      </span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
