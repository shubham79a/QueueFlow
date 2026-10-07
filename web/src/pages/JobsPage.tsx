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
  // Keep the status filter in the URL so it is shareable and survives reloads.
  const [params, setParams] = useSearchParams()

  // Ignore unknown URL values instead of sending an invalid status to the API.
  const raw = params.get('status') ?? ''
  const status: JobStatus | '' = (JOB_STATUSES as readonly string[]).includes(raw)
    ? (raw as JobStatus)
    : ''

  function changeStatus(next: JobStatus | '') {
    // Update the URL while preserving browser Back/Forward behavior.
    if (next) params.set('status', next)
    else params.delete('status')
    // A push, not a replace, so Back undoes the filter instead of leaving the page.
    setParams(params)
  }

  // Keep job creation in a dialog so the table remains visible.
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

          {/* New job dialog trigger. */}
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="h-4 w-4" />
            New job
          </Button>
        </div>
      </div>

      <NewJobForm open={creating} onOpenChange={setCreating} />

      {jobs.isError && (
        <p className="text-destructive text-sm">Could not load jobs: {jobs.error?.message}</p>
      )}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {/* Hide lower-priority columns on smaller screens. */}
              <TableRow>
                <TableHead>id</TableHead>
                <TableHead>type</TableHead>
                <TableHead>status</TableHead>
                <TableHead className="hidden sm:table-cell">attempts</TableHead>
                <TableHead className="hidden md:table-cell">created</TableHead>
                <TableHead className="hidden lg:table-cell">waited</TableHead>
                <TableHead className="hidden lg:table-cell">ran for</TableHead>
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
                  <TableCell className="hidden text-sm tabular-nums sm:table-cell">
                    {job.attempts}/{job.maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                    {timeAgo(job.createdAt)}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs tabular-nums lg:table-cell">
                    {duration(job.createdAt, job.startedAt)}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs tabular-nums lg:table-cell">
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
