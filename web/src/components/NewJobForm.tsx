import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createJob, type CreatedJob } from '@/api/jobs'
import { JOB_TYPES, type JobType } from '@/types'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Create a job from the browser.
//
// Typed fields rather than a JSON box: the shortest path to a running job should be
// "pick a type, press Create". Asking a visitor to hand-write valid JSON means their
// first experience of the project can be a syntax error.
//
// A DIALOG RATHER THAN A CARD IN THE PAGE. It used to open inline above the table,
// which pushed every row down the moment you pressed New job — so the thing you were
// about to add work to jumped out from under you, and on a phone the table left the
// screen entirely. It also had to compete with the table for width, which is why the
// fields were laid out in a cramped wrapping row.
//
// Defaults are chosen to work as-is. The webhook one points at the local test
// receiver, which is what `npm run dev:receiver` starts.
const DEFAULTS: Record<JobType, Record<string, string>> = {
  sleep: { ms: '5000' },
  always_fail: { message: 'this job always fails' },
  deliver_webhook: { url: 'http://127.0.0.1:4001/hook', timeoutMs: '10000' },
}

export default function NewJobForm({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const { canWrite } = useAuth()

  const [type, setType] = useState<JobType>('sleep')
  const [fields, setFields] = useState<Record<string, string>>(DEFAULTS.sleep)
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)

  // Switching type swaps the whole field set, so stale keys from the previous type
  // cannot leak into the payload.
  function changeType(next: JobType) {
    setType(next)
    setFields(DEFAULTS[next])
    setInvalid(null)
  }

  const set = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }))

  const payload = buildPayload(type, fields)

  const create = useMutation({
    mutationFn: () => createJob(type, payload, idempotencyKey.trim() || undefined),
    onSuccess: (res: CreatedJob) => {
      // The table below is a different query; tell it to refetch rather than waiting
      // out its 2s interval, so the new row appears immediately.
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['health'] })

      if (res.deduplicated) {
        // Deliberately stays open. Nothing was created, so closing would look like
        // success; leaving it up puts the idempotency key back in front of you, which
        // is the field that needs changing.
        toast.info('That key was already used — returned the original job, nothing created')
        return
      }
      toast.success('Job created')
      onOpenChange(false)
    },
    onError: (err) => toast.error(err.message),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()

    // The same rules the server enforces in validatePayload. Checked here only for
    // speed of feedback — the server still validates, and is the one that decides.
    const problem = check(type, payload)
    setInvalid(problem)
    if (!problem) create.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Accepted immediately and run by a worker. The row appears in the table below as
            soon as it exists.
          </DialogDescription>
        </DialogHeader>

        {/* A column, not a wrapping row. Inline in the page the fields had to share
            width with the table and ended up jammed side by side; a dialog has one
            job, so each field gets a full line and the same width at every size. */}
        {/* min-w-0 IS LOad-BEARING, not tidiness.
            DialogContent is a grid, and a grid item defaults to min-width:auto — it
            refuses to shrink below the intrinsic width of its content. The payload
            preview below is one long unbreakable line of JSON, so it set that width and
            the whole form grew past the dialog's border, taking the inputs and the
            buttons with it. min-w-0 lets the item shrink and the preview handle its own
            overflow. */}
        <form onSubmit={submit} className="min-w-0 space-y-5">
          <div className="space-y-2.5">
            <Label htmlFor="f-type">type</Label>
            <Select value={type} onValueChange={(v) => changeType(v as JobType)}>
              <SelectTrigger id="f-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JOB_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {Object.entries(fields).map(([key, value]) => (
            <div key={key} className="space-y-2.5">
              <Label htmlFor={`f-${key}`}>{key}</Label>
              <Input
                id={`f-${key}`}
                value={value}
                onChange={(e) => set(key, e.target.value)}
                className="w-full"
              />
            </div>
          ))}

          {showKey ? (
            <div className="space-y-2.5">
              <Label htmlFor="f-idem">Idempotency-Key</Label>
              <Input
                id="f-idem"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="order-4471"
                className="w-full"
              />
              <p className="text-muted-foreground text-xs">
                Send the same key twice and the second request returns the first job instead
                of creating another.
              </p>
            </div>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground h-auto p-0"
              onClick={() => setShowKey(true)}
            >
              + idempotency key
            </Button>
          )}

          {/* What actually goes over the wire. It makes the form self-explanatory
              rather than magic, and it is the same body the curl examples send. */}
          {/* Wraps rather than scrolls. A horizontal scrollbar inside a 512px dialog is
              fiddly to use and hides the end of the line, which is where the payload
              you just edited actually is. break-all because a url has no spaces to
              break on. */}
          <pre className="bg-muted text-muted-foreground rounded-md p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            POST /api/jobs {JSON.stringify({ type, payload })}
          </pre>

          {invalid && <p className="text-destructive text-sm">{invalid}</p>}
          {!canWrite && (
            <p className="text-muted-foreground text-sm">Sign in to create jobs.</p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canWrite || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create job'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Text inputs give strings; the API's validator wants numbers where it wants numbers.
function buildPayload(type: JobType, f: Record<string, string>): Record<string, unknown> {
  if (type === 'sleep') return { ms: Number(f.ms) }
  if (type === 'always_fail') return { message: f.message ?? '' }
  return { url: f.url ?? '', timeoutMs: Number(f.timeoutMs) }
}

function check(type: JobType, payload: Record<string, unknown>): string | null {
  if (type === 'sleep') {
    const ms = payload.ms as number
    if (!Number.isFinite(ms) || ms < 0) return 'ms must be a non-negative number'
  }

  if (type === 'deliver_webhook') {
    const url = payload.url as string
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'url is not a valid URL'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'url must be http or https'
    }
    const timeout = payload.timeoutMs as number
    if (!Number.isFinite(timeout) || timeout <= 0) return 'timeoutMs must be a positive number'
  }

  return null
}
