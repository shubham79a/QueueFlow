import { useQuery } from '@tanstack/react-query'
import { getHealth } from '@/api/health'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

// The numbers that say what the system is doing right now.
//
// All of it comes from /api/health, which already returned every one of these — the
// queue depths from Redis and the status tally from Postgres. Until now it was
// rendered as small text in the header; the data was always there, it just was not
// doing any work.
export default function StatCards() {
  const health = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 5000 })

  // SAY SO RATHER THAN VANISH.
  //
  // This used to `return null`, which was survivable when the only caller was the jobs
  // page — the table underneath reported its own failure. On the landing page these
  // cards are the whole of a section, so disappearing leaves a heading with nothing
  // under it, and a first-time visitor reads that as a broken site rather than an
  // unreachable API. Same choice HealthStrip already makes in the header.
  //
  // The wording is careful on purpose: this component talks to the API, and the API is
  // not the queue. Workers reach Redis and Postgres directly, so failing to load these
  // numbers means the dashboard cannot SEE the system — not that the system stopped.
  if (health.isError) {
    return (
      <Card className="gap-1 p-4">
        <span className="text-bad text-sm font-medium">API unreachable</span>
        <span className="text-muted-foreground text-sm leading-relaxed">
          These counts come from <code className="font-mono text-xs">/api/health</code>. Workers
          talk to Redis and Postgres directly, so this says the dashboard cannot reach the
          server — not that the queue has stopped.
        </span>
      </Card>
    )
  }

  const h = health.data
  const jobs = h?.jobs ?? {}

  const cards = [
    // `pending` is Redis's count of ids waiting, not a row count — it is the length of
    // the queue itself, which is the number an operator actually watches.
    { label: 'Pending', value: h?.pending, tone: 'text-status-queued-fg' },
    { label: 'Running', value: jobs.running, tone: 'text-status-running-fg' },
    // Retrying and delayed count the same jobs from the two stores. The ZSET is the
    // one that decides when they come back, so it is the one shown.
    { label: 'Retrying', value: h?.delayed, tone: 'text-status-retrying-fg' },
    { label: 'Succeeded', value: jobs.succeeded, tone: 'text-status-succeeded-fg' },
    { label: 'Dead', value: jobs.dead, tone: 'text-status-failed-fg' },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <Card key={c.label} className="gap-0 p-4">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {c.label}
          </span>
          {health.isPending ? (
            <Skeleton className="mt-2 h-8 w-16" />
          ) : (
            <span className={`mt-1 text-3xl font-semibold tabular-nums ${c.tone}`}>
              {(c.value ?? 0).toLocaleString()}
            </span>
          )}
        </Card>
      ))}
    </div>
  )
}
