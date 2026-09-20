import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { getJob } from '@/api/jobs'
import { ApiError } from '@/api/client'
import { duration, fmtTime, shortId, until } from '@/format'
import StatusBadge from '@/components/StatusBadge'
import ReplayButton from '@/components/ReplayButton'
import { Card } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

// One job, everything the row holds. Polls too, so you can sit on a retrying job and
// watch attempts climb and the next attempt time move.
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
      <div className="space-y-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{notFound ? 'No such job' : 'Could not load job'}</AlertTitle>
          <AlertDescription>{notFound ? id : job.error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!job.data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const j = job.data

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{shortId(j.id)}</h1>
        <StatusBadge status={j.status} />
        <span className="text-muted-foreground text-sm">{j.type}</span>
        <span className="text-muted-foreground text-sm tabular-nums">
          attempt {j.attempts} of {j.maxAttempts}
        </span>
        {/* Only dead jobs can be replayed — the API answers 409 otherwise, so the
            button is offered only where it applies. */}
        {j.status === 'dead' && (
          <span className="ml-auto">
            <ReplayButton jobId={j.id} />
          </span>
        )}
      </div>

      {/* The lifecycle, as a sequence rather than a list of fields. The two gaps are
          the two things the three timestamps exist to measure: how long the queue made
          it wait, and how long the work took. */}
      <Card className="p-5">
        <ol className="space-y-0">
          <Step label="created" time={fmtTime(j.createdAt)} done />
          <Gap text={j.startedAt ? `waited ${duration(j.createdAt, j.startedAt)}` : 'waiting…'} />
          <Step label="started" time={fmtTime(j.startedAt)} done={Boolean(j.startedAt)} />
          <Gap
            text={
              j.completedAt
                ? `ran for ${duration(j.startedAt, j.completedAt)}`
                : j.status === 'running'
                  ? 'running…'
                  : j.status === 'retrying' && j.nextRunAt
                    ? `backing off — next attempt ${until(j.nextRunAt)}`
                    : '—'
            }
          />
          <Step
            label={j.status === 'dead' ? 'died' : 'completed'}
            time={fmtTime(j.completedAt)}
            done={Boolean(j.completedAt)}
          />
        </ol>
      </Card>

      {j.lastError && (
        <Alert variant="destructive">
          <AlertTitle>last error</AlertTitle>
          <AlertDescription>
            <pre className="whitespace-pre-wrap">{j.lastError}</pre>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="payload">
          <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
            {JSON.stringify(j.payload, null, 2)}
          </pre>
        </Section>

        <Section title="record">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">id</dt>
            <dd className="font-mono text-xs break-all">{j.id}</dd>
            {j.idempotencyKey && (
              <>
                <dt className="text-muted-foreground">idempotency key</dt>
                <dd className="font-mono text-xs">{j.idempotencyKey}</dd>
              </>
            )}
            <dt className="text-muted-foreground">lease</dt>
            <dd className="text-muted-foreground font-mono text-xs break-all">
              {j.leaseId ?? '—'}
            </dd>
          </dl>
        </Section>
      </div>
    </div>
  )
}

function Step({ label, time, done }: { label: string; time: string; done: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${done ? 'bg-primary' : 'border-muted-foreground/40 border-2 bg-transparent'}`}
      />
      <span className={`text-sm ${done ? '' : 'text-muted-foreground'}`}>{label}</span>
      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{time}</span>
    </li>
  )
}

function Gap({ text }: { text: string }) {
  return (
    <li className="flex items-stretch gap-3">
      <span className="flex w-2.5 justify-center">
        <span className="bg-border w-px" />
      </span>
      <span className="text-muted-foreground py-1.5 text-xs">{text}</span>
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h2>
      {children}
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
    >
      <ArrowLeftIcon className="h-4 w-4" />
      all jobs
    </Link>
  )
}
