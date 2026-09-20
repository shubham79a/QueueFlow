import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { RotateCcwIcon } from 'lucide-react'
import { replayJob } from '@/api/jobs'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'

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
      toast.success('Replayed — back in the queue with attempts reset')
    },
    // 401 signed out, 409 if it is no longer dead. Both say something useful.
    onError: (err) => toast.error(err.message),
  })

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => replay.mutate()}
      disabled={!canWrite || replay.isPending}
      title={canWrite ? 'Requeue this job' : 'Sign in to replay'}
    >
      <RotateCcwIcon className="h-3.5 w-3.5" />
      {replay.isPending ? '…' : 'Replay'}
    </Button>
  )
}
