import { useMutation, useQueryClient } from '@tanstack/react-query'
import { replayJob } from '../api/jobs.ts'
import { useAuth } from '../auth.ts'

// Send a dead job back to the queue.
//
// This is what makes the dead-letter queue an inbox rather than a graveyard: someone
// reads the error, fixes the cause, and replays. The endpoint has existed since
// retries were added; this is the first thing other than curl to call it.
export default function ReplayButton({ jobId }: { jobId: string }) {
  const qc = useQueryClient()
  const { canWrite } = useAuth()

  const replay = useMutation({
    mutationFn: () => replayJob(jobId),
    onSuccess: () => {
      // Both the DLQ list and this job's own record just changed — the job is
      // 'queued' again with attempts back to zero.
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['job', jobId] })
    },
  })

  return (
    <>
      <button onClick={() => replay.mutate()} disabled={!canWrite || replay.isPending}>
        {replay.isPending ? '…' : 'Replay'}
      </button>
      {!canWrite && <span className="hint"> sign in to replay</span>}
      {replay.isError && <span className="error"> {replay.error.message}</span>}
    </>
  )
}
