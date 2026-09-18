import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createJob, type CreatedJob } from '../api/jobs.ts'
import { JOB_TYPES, type JobType } from '../types.ts'
import { useAuth } from '../auth.ts'

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
      if (!res.deduplicated) onDone()
    },
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
    <form className="newjob" onSubmit={submit}>
      <div className="form-row">
        <label>
          type{' '}
          <select value={type} onChange={(e) => changeType(e.target.value as JobType)}>
            {JOB_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        {Object.entries(fields).map(([key, value]) => (
          <label key={key}>
            {key}{' '}
            <input
              value={value}
              onChange={(e) => set(key, e.target.value)}
              size={key === 'url' || key === 'message' ? 34 : 8}
            />
          </label>
        ))}
      </div>

      <div className="form-row">
        <button type="submit" className="primary" disabled={!canWrite || create.isPending}>
          {create.isPending ? 'creating…' : 'Create'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>

        {!showKey && (
          <button type="button" className="linkish" onClick={() => setShowKey(true)}>
            + idempotency key
          </button>
        )}
        {showKey && (
          <label>
            Idempotency-Key{' '}
            <input
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              placeholder="order-4471"
              size={16}
            />
          </label>
        )}

        {!canWrite && <span className="hint">sign in to create jobs</span>}
        {invalid && <span className="error">{invalid}</span>}
        {create.isError && <span className="error">{create.error.message}</span>}
        {create.data?.deduplicated && (
          <span className="hint">
            that key was already used — returned the original job, nothing new created
          </span>
        )}
      </div>

      {/* What actually goes over the wire. Four lines, and it makes the form
          self-explanatory rather than magic. */}
      <pre className="preview">POST /api/jobs {JSON.stringify({ type, payload })}</pre>
    </form>
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
