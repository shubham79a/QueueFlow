import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { listJobs } from '@/api/jobs'
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

// How often the table asks the API for fresh rows. This one number is the whole
// "live" feature — TanStack Query refetches on the interval and React re-renders
// whatever changed.
const REFRESH_MS = 2000

const ALL = '__all__'

export default function JobsPage() {
  const [status, setStatus] = useState<JobStatus | ''>('')
  // The form lives here rather than on its own route so a new job appears in the
  // table below the moment it is created — that is the whole demo.
  const [creating, setCreating] = useState(false)

  const jobs = useQuery({
    // The status is part of the key, so switching the filter is a different query
    // with its own cache entry — flipping back shows the old rows instantly while
    // the fresh ones load.
    queryKey: ['jobs', status],
    queryFn: () => listJobs(status),
    refetchInterval: REFRESH_MS,
  })

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
            onValueChange={(v) => setStatus(v === ALL ? '' : (v as JobStatus))}
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
        <p className="text-destructive text-sm">Could not load jobs: {jobs.error.message}</p>
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

              {jobs.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                    No jobs{status ? ` with status "${status}"` : ''} yet — press{' '}
                    <span className="font-medium">New job</span> to create one.
                  </TableCell>
                </TableRow>
              )}

              {jobs.data?.map((job) => (
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
      </Card>
    </div>
  )
}
