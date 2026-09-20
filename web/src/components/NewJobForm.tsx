import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createJob, type CreatedJob } from '@/api/jobs'
import { JOB_TYPES, type JobType } from '@/types'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
// Defaults are chosen to work as-is. The webhook one points at the local test
// receiver, which is what `npm run dev:receiver` starts.
const DEFAULTS: Record<JobType, Record<string, string>> = {
  sleep: { ms: '5000' },
  always_fail: { message: 'this job always fails' },
  deliver_webhook: { url: 'http://127.0.0.1:4001/hook', timeoutMs: '10000' },
}

export default function NewJobForm({ onDone }: { onDone: () => void }) {
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
        toast.info('That key was already used — returned the original job, nothing created')
        return
      }
      toast.success('Job created')
      onDone()
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
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label>type</Label>
            <Select value={type} onValueChange={(v) => changeType(v as JobType)}>
              <SelectTrigger className="w-48">
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
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`f-${key}`}>{key}</Label>
              <Input
                id={`f-${key}`}
                value={value}
                onChange={(e) => set(key, e.target.value)}
                className={key === 'url' || key === 'message' ? 'w-80' : 'w-32'}
              />
            </div>
          ))}

          {showKey && (
            <div className="space-y-1.5">
              <Label htmlFor="f-idem">Idempotency-Key</Label>
              <Input
                id="f-idem"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="order-4471"
                className="w-44"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!canWrite || create.isPending}>
            {create.isPending ? 'creating…' : 'Create'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          {!showKey && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowKey(true)}
            >
              + idempotency key
            </Button>
          )}

          {!canWrite && (
            <span className="text-muted-foreground text-xs">sign in to create jobs</span>
          )}
          {invalid && <span className="text-destructive text-xs">{invalid}</span>}
        </div>

        {/* What actually goes over the wire. It makes the form self-explanatory
            rather than magic, and it is the same body the curl examples send. */}
        <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md p-3 font-mono text-xs">
          POST /api/jobs {JSON.stringify({ type, payload })}
        </pre>
      </form>
    </Card>
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
