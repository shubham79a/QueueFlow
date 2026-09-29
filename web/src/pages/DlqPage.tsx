import { Link } from 'react-router-dom'
import { useJobList } from '@/hooks/useJobList'
import { shortId, timeAgo } from '@/format'
import ReplayButton from '@/components/ReplayButton'
import LoadMore from '@/components/LoadMore'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Jobs that ran out of attempts.
//
// There is no separate Redis list for these — the dead-letter queue is just
// `WHERE status = 'dead'`. A second copy of that fact could disagree with the row
// holding the error and the timings, so there is only the row.
export default function DlqPage() {
  const jobs = useJobList('dead')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Dead-letter queue</h1>
        <span className="text-muted-foreground text-xs">
          read the error, fix the cause, replay
        </span>
      </div>

      {jobs.isError && (
        <p className="text-destructive text-sm">Could not load the DLQ: {jobs.error?.message}</p>
      )}

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {/* Columns drop out as the screen narrows, same as the jobs table — but
                  the priority is different. There, the timings go first because they are
                  the reason to open a job. Here you came to read the error and press
                  Replay, so those two survive to the narrowest width and everything
                  describing the job goes instead. */}
              <TableRow>
                <TableHead>id</TableHead>
                <TableHead className="hidden sm:table-cell">type</TableHead>
                <TableHead className="hidden lg:table-cell">attempts</TableHead>
                <TableHead className="hidden md:table-cell">died</TableHead>
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

              {!jobs.isPending && jobs.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                    Nothing dead. Everything either succeeded or is still trying.
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
                  <TableCell className="hidden text-sm sm:table-cell">{job.type}</TableCell>
                  <TableCell className="hidden text-sm tabular-nums lg:table-cell">
                    {job.attempts}/{job.maxAttempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm md:table-cell">
                    {job.completedAt ? timeAgo(job.completedAt) : ''}
                  </TableCell>
                  {/* Errors get long. One line here with the whole thing in the
                      tooltip, and the full text on the detail page.
                      The cap has to be narrower than the viewport or truncate has
                      nothing to truncate against and the row pushes the table wider
                      than the screen — max-w-md is 28rem, which is already wider than
                      a 390px phone. */}
                  <TableCell
                    className="text-bad max-w-44 truncate font-mono text-xs sm:max-w-xs lg:max-w-md"
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
