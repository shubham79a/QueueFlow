# Gaps — Phase 4 (retries, backoff, dead-letter queue)

Deliberate omissions. Each says what is missing, why it was left, and how to see it.

| ID | Gap | Closed by |
| --- | --- | --- |
| GAP-4.1 | Every error is treated as retryable | not planned |
| GAP-4.2 | The scheduler is a single point of failure, and a silent one | not planned — run two |
| GAP-4.3 | Retries only cover handlers that *threw*; a killed worker still strands its job | **closed** — reaper |
| GAP-4.4 | Retrying an unknown outcome can duplicate a side effect | **half closed** — record only, see GAP-5.1 |
| GAP-4.5 | One retry policy for everything; `max_attempts` is never varied | not planned |
| GAP-4.6 | A replayed job loses its history | not planned |

---

## GAP-4.1 — Every error is retryable

**What.** A handler that throws is retried, whatever it threw. A webhook returning `400 Bad
Request` because the payload is malformed will be retried five times over half a minute, and fail
identically each time. Nothing distinguishes *"try again later"* from *"this will never work"*.

**Why left.** The classification is genuinely per-integration: `429` and `503` are transient, `400`
and `422` are permanent, and `404` could be either depending on whose API it is. Encoding a general
rule would be guessing, and encoding a per-handler rule is a bigger design than this phase.

**How to see it.**
```bash
curl.exe -X POST http://localhost:4000/jobs -H "Content-Type: application/json" ^
  -d "{\"type\":\"deliver_webhook\",\"payload\":{\"url\":\"http://127.0.0.1:4001/hook/down\"}}"
```
Five attempts against a receiver that returns 500 every time, then `dead`.

**If it needed fixing.** A handler would signal retryability, e.g. by throwing a typed error, and a
permanent failure would go straight to `failed` — which is the reason `failed` remains in the status
constraint despite nothing writing it today.

---

## GAP-4.2 — The scheduler is a silent single point of failure

**What.** Nothing promotes a delayed job except the scheduler. If it dies, every `retrying` job
stays in the delayed set forever. The API keeps returning 202, workers keep draining `pending`, and
nothing anywhere reports a problem — the only symptom is a `delayed` count that stops falling.

**Why left.** `ZREM` returning 1 is an atomic claim, so **running two schedulers is already safe**
and is the intended answer. What is missing is an operator noticing that zero are running, which is
monitoring rather than code.

**How to see it.** Start one scheduler, enqueue an `always_fail` job, kill the scheduler mid-cycle:
```sql
SELECT id, attempts, next_run_at FROM jobs WHERE status = 'retrying';
```
The row sits there with a `next_run_at` in the past, indefinitely.

**Mitigation available today.** `GET /health` reports `delayed`. A delayed count that is not
decreasing while jobs are failing means the scheduler is gone.

---

## GAP-4.3 — Retries only cover handlers that threw

**What.** The retry lives in the worker's `catch` block, so it requires the worker to still be alive
to schedule it. A worker killed mid-job never reaches that code: the row stays at `running`, the id
is gone from Redis, and no retry is ever scheduled.

**Why this matters here.** It is the sharp edge of this phase. Retries make *handler failures*
recoverable while leaving *process failures* exactly as broken as they were — and the two are
indistinguishable from the outside, because both end with a job that did not happen.

**How to see it.** Enqueue a 30-second `sleep`, kill the worker mid-flight:
```sql
SELECT status, attempts, next_run_at FROM jobs WHERE status = 'running';
```
Still `running`, `next_run_at` NULL, nothing scheduled. Compare with `always_fail`, which reaches
`dead` on its own.

**Closed.** The retry is no longer the only recovery path. A process failure is now caught by a
different mechanism entirely — the job's id survives the crash in a processing list, the worker's
silence is detected by an expiring heartbeat, and the reaper returns the job to the queue. A handler
that throws and a worker that dies now converge on the same outcome: the job runs again.

---

## GAP-4.4 — Retrying an unknown outcome can duplicate a side effect

**What.** A `deliver_webhook` job that times out is recorded as failed and retried. But a timeout is
not a failure — it is an absence of information. The receiver may have processed the request fully
and simply answered too late. Retrying delivers it a second time.

**Why this phase makes it worse.** Before retries, a timeout meant one delivery and a dead job.
Now it means up to five deliveries of the same webhook to a receiver that may have accepted every
one of them. **This phase increases the number of duplicate side effects in the system.**

**How to see it** — both accounts of the same events, disagreeing:
```bash
curl.exe -X POST http://localhost:4000/jobs -H "Content-Type: application/json" ^
  -d "{\"type\":\"deliver_webhook\",\"payload\":{\"url\":\"http://127.0.0.1:4001/hook/slow\",\"timeoutMs\":500}}"
curl.exe http://localhost:4001/deliveries
```
`GET /deliveries` will show several deliveries of one job id. The `jobs` row will show attempts that
all "failed".

**Why it cannot be fixed by tuning.** Any timeout is a guess, and a receiver slower than the guess is
indistinguishable from one that is dead. The answer is not to prevent the second delivery but to make
it harmless — which is what `X-QueueFlow-Job-Id` on every request and the unused
`idempotency_key UNIQUE` column are already in place for.

**Half closed, and the half that remains is the point.** The lease closed the record: one job now
produces one `job_effects` row even when two workers ran it. The `Idempotency-Key` header closed the
other direction, where a caller submits the same work twice.

Neither touches the delivery itself. A worker fenced out at commit time had already sent its request
several seconds earlier, and no mechanism in this system can recall it. That is GAP-5.1, it is not
fixable from this side, and the answer is the receiver recognising the `X-QueueFlow-Job-Id` it has
already handled — which `/hook/idempotent` demonstrates and `test/crash.test.ts` asserts: one effect
row, **two** deliveries, one applied.

---

## GAP-4.5 — One retry policy for everything

**What.** `nextDelayMs` is global and `max_attempts` defaults to 5 for every job. A webhook to a
flaky third party and an internal job that should fail fast get identical treatment.

**Why left.** Per-type policy is a small change (a lookup keyed on job type) but it needs real cases
to be designed against rather than invented.

**Partly available already.** `max_attempts` is a per-row column, so a caller could set it per job;
nothing exposes that through the API yet.

---

## GAP-4.6 — A replayed job loses its history

**What.** `POST /jobs/:id/replay` resets `attempts`, `last_error`, `started_at` and `completed_at`.
The record of why it died the first time is overwritten.

**Why left.** Keeping it means an attempts table — one row per execution, with its own error and
timings — which is a schema change worth doing deliberately. `job_effects` is already close to that
shape and would likely absorb it.

**Workaround.** Note the `last_error` before replaying; the receiver's own log is unaffected.
