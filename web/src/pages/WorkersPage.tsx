import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listWorkers } from '@/api/workers'
import { shortId } from '@/format'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Workers</h1>
        <span className="text-muted-foreground text-xs">
          from Redis alone — heartbeat keys and processing lists
        </span>
      </div>

      {workers.isError && (
        <p className="text-destructive text-sm">Could not load workers: {workers.error.message}</p>
      )}

      {workers.isPending && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      )}

      {workers.data?.length === 0 && (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">
            No workers running. Start one with <code className="font-mono">npm run dev:worker</code>
            .
          </p>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {workers.data?.map((w) => {
          // The card this page exists for: the heartbeat has lapsed but the processing
          // list is not empty. That is a crashed worker, seen in the window between its
          // key expiring and the reaper's next pass.
          const stranded = !w.alive && w.holding > 0

          return (
            <Card
              key={w.id}
              className={`gap-3 p-4 ${stranded ? 'border-bad bg-bad/5' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${w.alive ? 'bg-ok' : 'bg-bad animate-pulse'}`}
                />
                <span className="truncate font-mono text-sm">{w.id}</span>
                <span
                  className={`ml-auto text-xs font-medium ${w.alive ? 'text-ok' : 'text-bad'}`}
                >
                  {w.alive ? 'alive' : 'gone'}
                </span>
              </div>

              <div className="text-muted-foreground flex items-baseline gap-4 text-xs">
                <span className="tabular-nums">
                  heartbeat{' '}
                  {w.expiresInSeconds !== null ? `${w.expiresInSeconds}s left` : 'expired'}
                </span>
                <span className="tabular-nums">holding {w.holding}</span>
              </div>

              {stranded && (
                <p className="text-bad text-xs">
                  stopped responding — the reaper will return these jobs
                </p>
              )}

              {w.jobs.length > 0 && (
                <div className="flex flex-wrap gap-x-2 gap-y-1">
                  {w.jobs.map((id) => (
                    <Link
                      key={id}
                      to={`/jobs/${id}`}
                      className="text-primary font-mono text-xs hover:underline"
                    >
                      {shortId(id)}
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
