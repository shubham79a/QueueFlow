import { useQuery } from '@tanstack/react-query'
import { getHealth } from '../api/health.ts'
import { JOB_STATUSES } from '../types.ts'

// Lives in the header, so it is on every page. Two dots for the two dependencies,
// the queue depths, and a tally of jobs by status.
export default function HealthStrip() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 5000,
  })

  // The API itself is unreachable — different from the API saying a dependency is
  // down, which comes back as data with status 'degraded'.
  if (health.isError) {
    return (
      <div className="health">
        <span className="dot dot-bad" /> <span className="error">API unreachable</span>
      </div>
    )
  }

  if (!health.data) return null

  const h = health.data
  const redisUp = h.redis === 'PONG'
  const pgUp = h.postgres === 'ok'

  return (
    <div className="health">
      <span title={redisUp ? 'Redis up' : `Redis: ${h.redis}`}>
        <span className={`dot ${redisUp ? 'dot-ok' : 'dot-bad'}`} /> redis
      </span>
      <span title={pgUp ? 'Postgres up' : `Postgres: ${h.postgres}`}>
        <span className={`dot ${pgUp ? 'dot-ok' : 'dot-bad'}`} /> postgres
      </span>

      {redisUp && (
        <span className="muted">
          pending {h.pending} · delayed {h.delayed}
        </span>
      )}

      {pgUp && h.jobs && (
        <span className="tally">
          {JOB_STATUSES.map((s) => {
            const n = h.jobs?.[s]
            return n ? (
              <span key={s} className={`badge badge-${s}`}>
                {s} {n}
              </span>
            ) : null
          })}
        </span>
      )}

      {h.status === 'degraded' && (
        <span className="error">degraded — {!redisUp ? h.redis : h.postgres}</span>
      )}
    </div>
  )
}
