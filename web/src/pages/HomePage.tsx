import { Link } from 'react-router-dom'
import { ArrowRightIcon } from 'lucide-react'
import ArchitectureDiagram from '@/components/ArchitectureDiagram'
import StatCards from '@/components/StatCards'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

const REPO = 'https://github.com/shubham79a/QueueFlow'

// The three things the system claims, each with the mechanism that backs it.
//
// Claims without mechanisms are marketing. Every one of these names the specific
// Redis or Postgres operation that makes it true, because the mechanism is the
// interesting part and it is what someone reading this will want to check.
const GUARANTEES = [
  {
    title: 'A job is never in transit',
    body: 'BLMOVE takes an id off the shared queue and puts it on the worker’s own list as one atomic step. At every instant the id is in exactly one place — never only in a process’s memory, which is what makes a crash recoverable rather than fatal.',
  },
  {
    title: 'Absence is the death notice',
    body: 'A worker refreshes a TTL key; Redis expires it. Nothing has to notice a crash and report it — the key simply stops existing, and the reaper returns whatever that worker was still holding.',
  },
  {
    title: 'Duplicate work is harmless',
    body: 'Exactly-once delivery is impossible. Database-backed leases and idempotency keys make at-least-once delivery produce an exactly-once effect, which is the achievable version of the same promise.',
  },
]

// Numbers from `npm run bench` and test/chaos.test.ts, quoted as measured.
const MEASURED = [
  { value: '1,039', unit: 'jobs/s', note: '3 workers × 20 concurrency, 1 ms jobs' },
  { value: '320', unit: 'jobs killed', note: '8 rounds of random SIGKILL — 0 lost, 0 duplicated' },
  { value: '~1,197', unit: 'jobs/s ceiling', note: 'Postgres commit rate — 3 durable writes per job' },
]

export default function HomePage() {
  return (
    <div className="space-y-16 py-8 sm:py-12">
      {/* ---- hero ---- */}
      <section className="max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">QueueFlow</h1>
        <p className="text-muted-foreground mt-4 text-base leading-relaxed sm:text-lg">
          A distributed background job queue built directly on Redis primitives — no BullMQ, no
          Bee-Queue. An HTTP API accepts work and returns immediately; separate worker processes run
          it. <span className="text-foreground">Kill a worker mid-job and the job comes back on its own.</span>
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/jobs">
              Open the dashboard
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <a href={REPO} target="_blank" rel="noreferrer">
              <GithubMark />
              Source
            </a>
          </Button>
        </div>
      </section>

      {/* ---- what it is doing right now ----
          The same component the operator view uses. A landing page that shows live
          numbers is making a claim it can be checked on, which is the point. */}
      <section>
        <SectionHeading
          title="Right now"
          note="live from /api/health — Redis queue depths and the Postgres status tally"
        />
        <StatCards />
      </section>

      {/* ---- how it works ---- */}
      <section>
        <SectionHeading
          title="How it works"
          note="the whole system — two stores, and what each one is for"
        />
        <Card className="p-4 sm:p-6">
          <ArchitectureDiagram />
        </Card>

        <p className="text-muted-foreground mt-6 max-w-3xl text-sm leading-relaxed">
          Redis is fast and volatile, so it carries ids and nothing else. Postgres is the permanent
          record — it answers <em>what happened to job X</em> long after Redis has forgotten it. The
          two cannot be written atomically, so the row is inserted <em>before</em> the id is pushed:
          a crash between them leaves a queued row a query can find, rather than a worker holding an
          id for a job that was never recorded.
        </p>
      </section>

      {/* ---- the guarantees ---- */}
      <section>
        <SectionHeading title="What makes it hard" note="and the mechanism behind each claim" />
        <div className="grid gap-4 md:grid-cols-3">
          {GUARANTEES.map((g) => (
            <Card key={g.title} className="gap-2 p-5">
              <h3 className="font-medium">{g.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{g.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* ---- measured ---- */}
      <section>
        <SectionHeading title="Measured" note="npm run bench, and test/chaos.test.ts" />
        <div className="grid gap-4 sm:grid-cols-3">
          {MEASURED.map((m) => (
            <Card key={m.unit} className="gap-1 p-5">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums">{m.value}</span>
                <span className="text-muted-foreground text-sm">{m.unit}</span>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed">{m.note}</p>
            </Card>
          ))}
        </div>
        <p className="text-muted-foreground mt-6 max-w-3xl text-sm leading-relaxed">
          Throughput plateaus near 1,000 jobs/s, and the dependency benchmarks say why: three durable
          Postgres writes per job put the ceiling around 1,197. Adding workers past that produces more
          in-flight jobs and longer queue waits, not more completed work.
        </p>
      </section>
    </div>
  )
}

// Inline rather than from lucide — lucide v1 dropped its brand icons, and this is
// the one place the app needs one.
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

function SectionHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{note}</p>
    </div>
  )
}
