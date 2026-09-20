import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PlusIcon } from 'lucide-react'
import { useJobList } from '@/hooks/useJobList'
import LoadMore from '@/components/LoadMore'
import { JOB_STATUSES, type JobStatus } from '@/types'
import { duration, shortId, timeAgo } from '@/format'
import StatusBadge from '@/components/StatusBadge'
import StatCards from '@/components/StatCards'
import NewJobForm from '@/components/NewJobForm'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// The Select needs a non-empty value for "no filter" — an empty string would make it
// look unset rather than deliberately showing everything.
const ALL = '__all__'

export default function JobsPage() {
  /**
   * The filter lives in the URL, not in useState.
   *
   * "Look at the dead ones" is a thing you send someone, so it has to survive being
   * copied out of the address bar. Keeping it in component state meant
   * /jobs?status=dead did not exist: the link was unshareable, a reload reset it,
   * and Back left the page instead of undoing the filter.
   *
   * What does NOT go here is the paging cursor. You do not have "a page" — you have
   * however many you have loaded — and a cursor names an instant that has already
   * passed on a list that keeps growing. A shared link would reopen last Tuesday.
   * Numbered pagination would belong in the URL; keyset does not.
   */
  const [params, setParams] = useSearchParams()

  // Anyone can type into the address bar, and an unknown status would make the API
  // answer 400. Treat anything unrecognised as no filter at all.
  const raw = params.get('status') ?? ''
  const status: JobStatus | '' = (JOB_STATUSES as readonly string[]).includes(raw)
    ? (raw as JobStatus)
    : ''

  function changeStatus(next: JobStatus | '') {
    // Dropping the parameter entirely rather than leaving `?status=` — the URL for
    // "everything" should just be `/jobs`.
    if (next) params.set('status', next)
    else params.delete('status')
    // A push, not a replace, so Back undoes the filter instead of leaving the page.
    setParams(params)
  }

  // The form lives here rather than on its own route so a new job appears in the
  // table below the moment it is created — that is the whole demo.
  const [creating, setCreating] = useState(false)

  const jobs = useJobList(status)

  return (
    <div className="space-y-6">
      <StatCards />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Jobs</h1>

        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="bg-ok h-1.5 w-1.5 animate-pulse rounded-full" />
          live
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={status === '' ? ALL : status}
            onValueChange={(v) => changeStatus(v === ALL ? '' : (v as JobStatus))}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {JOB_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {!creating && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon className="h-4 w-4" />
              New job
            </Button>
          )}
        </div>
      </div>

      {creating && <NewJobForm onDone={() => setCreating(false)} />}

      {jobs.isError && (
        <p className="text-destructive text-sm">Could not load jobs: {jobs.error?.message}</p>
      )}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id</TableHead>
                <TableHead>type</TableHead>
                <TableHead>status</TableHead>
                <TableHead>attempts</TableHead>
                <TableHead>created</TableHead>
                <TableHead>waited</TableHead>
                <TableHead>ran for</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.isPending &&
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {!jobs.isPending && jobs.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                    No jobs{status ? ` with status "${status}"` : ''} yet — press{' '}
                    <span className="font-medium">New job</span> to create one.
                  </TableCell>
                </TableRow>
              )}

              {jobs.rows.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Link
                      to={`/jobs/${job.id}`}
                      className="text-primary font-mono text-xs hover:underline"
                    >
                      {shortId(job.id)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{job.type}</TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {job.attempts}/{job.maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {timeAgo(job.createdAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {duration(job.createdAt, job.startedAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {duration(job.startedAt, job.completedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <LoadMore
          shown={jobs.rows.length}
          total={jobs.total}
          hasNextPage={jobs.hasNextPage}
          isFetching={jobs.isFetchingNextPage}
          onLoadMore={() => void jobs.fetchNextPage()}
        />
      </Card>
    </div>
  )
}
