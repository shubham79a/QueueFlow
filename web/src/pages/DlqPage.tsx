import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listJobs } from '@/api/jobs'
import { shortId, timeAgo } from '@/format'
import ReplayButton from '@/components/ReplayButton'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Jobs that ran out of attempts.
//
// There is no separate Redis list for these — the dead-letter queue is just
// `WHERE status = 'dead'`. A second copy of that fact could disagree with the row
// holding the error and the timings, so there is only the row.
export default function DlqPage() {
  const jobs = useQuery({
    queryKey: ['jobs', 'dead'],
    queryFn: () => listJobs('dead'),
    refetchInterval: 2000,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Dead-letter queue</h1>
        <span className="text-muted-foreground text-xs">
          read the error, fix the cause, replay
        </span>
      </div>

      {jobs.isError && (
        <p className="text-destructive text-sm">Could not load the DLQ: {jobs.error.message}</p>
      )}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id</TableHead>
                <TableHead>type</TableHead>
                <TableHead>attempts</TableHead>
                <TableHead>died</TableHead>
                <TableHead>last error</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.isPending &&
                Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {jobs.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                    Nothing dead. Everything either succeeded or is still trying.
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
                  <TableCell className="text-sm tabular-nums">
                    {job.attempts}/{job.maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {job.completedAt ? timeAgo(job.completedAt) : ''}
                  </TableCell>
                  {/* Errors get long. One line here with the whole thing in the
                      tooltip, and the full text on the detail page. */}
                  <TableCell
                    className="text-bad max-w-md truncate font-mono text-xs"
                    title={job.lastError ?? ''}
                  >
                    {job.lastError}
                  </TableCell>
                  <TableCell className="text-right">
                    <ReplayButton jobId={job.id} />
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
