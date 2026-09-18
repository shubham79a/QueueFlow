# QueueFlow

A distributed background job queue built directly on Redis primitives — no BullMQ, Bee-Queue or
Agenda. The handoff protocol, lifecycle tracking, failure recording and recovery machinery are
implemented here rather than delegated, so the policy decisions stay explicit and reviewable.

An HTTP API accepts work and returns immediately. Separate worker processes consume and execute it.
Redis carries job ids between them; Postgres holds the payloads, outcomes and timings. A job survives
the death of the process running it: `kill -9` a worker mid-job and the job comes back on its own —
and a dashboard, served by the API, lets you watch that happen.

---

## Architecture

```text
        client
          │ POST /jobs                       ┌────────────┐
          ▼                                  │  Postgres  │  the record: payloads,
     Express API ───────────INSERT──────────▶│            │  status, attempts,
       (:4000)                               └────────────┘  timings, lease, effects
          │                                    ▲    ▲    ▲
          │ LPUSH id                           │    │    │
          ▼                                    │    │    │
 ┌───────────────────┐                       claim run settle
 │ queueflow:pending │ LIST                    │    │    │
 └───────────────────┘                         │    │    │
    ▲            │ BLMOVE  (atomic, blocking)  │    │    │
    │            ▼                             │    │    │
    │  ┌─────────────────────────┐             │    │    │
    │  │ queueflow:processing:w1 │ LIST ───────┴────┴────┘
    │  └─────────────────────────┘   the job sits HERE while it runs,
    │            │                   so kill -9 cannot lose it
    │            │ LREM once the outcome is recorded
    │            │ ZADD on failure
    │            ▼
    │  ┌───────────────────┐
    │  │ queueflow:delayed │ ZSET, scored by run-at
    │  └───────────────────┘
    │            │
    │   ┌────────┴───────────┐
    └───│ scheduler + reaper │  returns jobs to pending when:
        └────────────────────┘   · a backoff has elapsed          (delayed ZSET)
                   │              · a worker has gone quiet        (heartbeat)
                   ▼              · a row was never enqueued       (orphan sweep)
            worker:w1:alive   STRING with a TTL. The worker refreshes it, Redis
                              expires it. Its absence IS the death notice.
```

**Why both stores.** Redis is fast and volatile, and is used only as a transport — it holds job ids
and nothing else. Postgres is the permanent record: it answers "what happened to job X", "what is
still queued", and "how long do jobs wait before they start". Redis alone cannot answer any question
about a job it has already handed out.

**Write ordering.** The two stores cannot be written atomically — no transaction spans them. The row
is inserted *before* the id is pushed, so a crash between the two leaves a `queued` row that a query
can find, rather than a worker holding an id for a job that was never recorded. An orphan you can
find beats a ghost you cannot.

**The id is never in transit.** `BLMOVE` takes a job off the shared queue and puts it on the worker's
own list as one atomic step, so at every instant the id is in exactly one place. Nothing is ever held
only in a process's memory, which is what makes a crash recoverable rather than fatal.

---

## Running it

Requires Node ≥ 22 and Docker.

```bash
npm install
cp .env.example .env      # optional; every value has a default in code
npm run up                # redis + postgres
npm run db:migrate        # applies db/schema.sql
```

Then, in separate terminals:

```bash
npm run dev:api        # accepts work
npm run dev:worker     # runs it
npm run dev:scheduler  # puts work back: due retries, and jobs lost with a dead worker
```

The worker takes no port and serves nothing — it is not a server. It connects out to Redis and
Postgres and waits. Run as many as you like; nothing needs to be told they exist. Without the
scheduler everything still runs, but a failed job never retries and a crashed worker's jobs never
come back — which is worth seeing once, deliberately.

### Dashboard

A React app in [web/](web/) that shows the system as it runs. Read-only, no login:

| Page | Shows |
| --- | --- |
| **Jobs** | recent jobs with a status filter — queue wait and run time per row, refreshing every 2 s |
| **Job detail** | one job: payload, attempts, error, all three timestamps, the next retry if it is backing off |
| **Workers** | every worker from its heartbeat key — alive or gone, TTL counting down, what it is holding. Kill a worker mid-job and watch its row turn red, then empty as the reaper takes over |
| **Health strip** | in the header: Redis and Postgres up or down, queue depth, jobs by status |

In development it runs on its own port and proxies API calls through:

```bash
cd web && npm install     # one time
npm run dev:web           # http://localhost:5173
```

In production it is built to static files and **served by the API process itself** — one port, one
deployable, no CORS:

```bash
npm run build:web         # web/dist
npm run dev:api           # now also serves the dashboard at http://localhost:4000
```

The API checks for `web/dist/index.html` at startup and serves it if present; otherwise it runs
exactly as before. Every JSON route lives under `/api` so the two never collide.

### Submitting work

```bash
curl -X POST http://localhost:4000/api/jobs \
  -H 'Authorization: Bearer <your key>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"sleep","payload":{"ms":5000}}'
```

```json
{ "jobId": "26c98da8-4a12-45f1-8596-05f41448a898", "status": "queued" }
```

`202 Accepted`, not `200 OK` — the work has not been done, and the API never observes its outcome.

### API

All routes are under `/api`; everything else is the dashboard.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/jobs` | **key** | Submit work. Returns `202` with the job id |
| `POST /api/jobs/:id/replay` | **key** | Requeue a dead job. `409` unless it is dead |
| `GET /api/jobs/:id` | open | Full record: status, attempts, error, timings |
| `GET /api/jobs?status=&limit=` | open | Recent jobs, newest first |
| `GET /api/workers` | open | Live workers, heartbeat TTL remaining, and what each is holding |
| `GET /api/health` | open | Redis and Postgres reachability, pending/delayed depth, status tally |

**Authentication.** Writing needs a key; reading does not, so the dashboard is viewable by anyone.
Generate a key and put it in `.env`:

```bash
npm run key:new          # prints qf_…
# API_KEYS=qf_…          in .env, comma-separated for more than one
```

Callers send it as `Authorization: Bearer <key>`. A missing or unknown key gets `401`. Keys are
compared in constant time and never logged.

**With `API_KEYS` empty the write routes are open** — so a fresh clone runs with no setup — and the
API says so loudly at startup. Set a key before deploying anywhere reachable: `deliver_webhook`
means an open `POST /api/jobs` lets a stranger make your server send requests to any URL.

**`Idempotency-Key`.** `POST /api/jobs` accepts the header, and sending the same key twice returns the
original job with `200` and `deduplicated: true` rather than creating a second one. It exists because
a caller whose connection drops before the response has no way to tell a failed submission from a
successful one it never heard about, and retrying is the right thing for it to do.

```bash
curl -X POST http://localhost:4000/api/jobs -H 'Idempotency-Key: order-4471' \
  -H 'Authorization: Bearer <your key>' \
  -H 'Content-Type: application/json' -d '{"type":"sleep","payload":{"ms":10}}'
```

This is a different problem from a job being *run* twice — see [Surviving a dead
worker](#surviving-a-dead-worker), which is about the other one.

### Job types

| Type | Payload | Behaviour |
| --- | --- | --- |
| `sleep` | `{ ms: number }` | Waits, then succeeds. A controlled variable for reliability testing |
| `always_fail` | `{ message?: string }` | Throws. A fixture for the failure path |
| `deliver_webhook` | `{ url, body?, timeoutMs? }` | POSTs JSON to `url`. Fails on non-2xx, connection refusal, or timeout |

### Testing webhook delivery

`npm run dev:receiver` starts a stand-in receiver on port 4001 that can be made to fail on demand:

| Route | Behaviour |
| --- | --- |
| `POST /hook` | Always succeeds |
| `POST /hook/idempotent` | Succeeds, but applies each `X-QueueFlow-Job-Id` at most once |
| `POST /hook/down` | Always returns 500 |
| `POST /hook/slow` | Holds the connection open for 60s |
| `POST /hook/flaky/:n` | Fails the first `n` deliveries of each job, then succeeds |
| `GET /deliveries` | What arrived (`total`) versus what took effect (`applied`) |

Add `?delayMs=N` to `/hook` or `/hook/idempotent` for a receiver that works but is slow — which is
the interesting failure, because it is what keeps a worker busy long enough to be mistaken for dead.

Each delivery carries `X-QueueFlow-Job-Id` and `X-QueueFlow-Attempt`, the way GitHub sends
`X-GitHub-Delivery`. `GET /deliveries` is deliberately an account of events from outside the
queue — when it disagrees with `job_effects`, the disagreement is the bug.

---

## Concurrency

Two independent dials, for two different bottlenecks:

| Dial | What it is | When it helps |
| --- | --- | --- |
| **Worker processes** | `npm run dev:workers 3` | CPU-bound work — a second process is a second core |
| **`CONCURRENCY`** | jobs in flight per process | IO-bound work — the event loop is idle during a timer or socket wait |

`sleep` and `deliver_webhook` are both IO-bound, so `CONCURRENCY` does most of the work here. A
handler that hashed passwords would occupy the event loop and gain nothing from it.

**No lock is used, and none is needed.** Redis executes commands one at a time, so simultaneous
`BRPOP`s from several workers are serialised by the server and each element goes to exactly one
caller. Mutual exclusion comes from the data store rather than being built on top of it.

**A slot is acquired before the pop, not after.** A job leaves Redis only when a worker is ready to
run it immediately, so work that cannot start stays in Redis — visible to `llen`, claimable by any
other worker, and not lost if this process dies. That is backpressure: consumer capacity, rather
than producer rate, decides when work is taken.

### Measured throughput

`npm run bench` sweeps the matrix. With 1ms jobs, so per-job overhead dominates rather than the
sleep itself:

```text
workers  conc   slots   jobs/s
      1     1       1      65.8
      1     5       5     486.7
      3     5      15     922.6
      3    20      60    1039.7      4× the slots, +13% throughput
```

Throughput plateaus near **1,000 jobs/s**, and measuring the dependencies says why:

| Dependency | Measured | Ops per job | Implied ceiling |
| --- | --- | --- | --- |
| Redis `LPUSH` + `RPOP` | 8,701/s | 2 | ~4,350 jobs/s |
| Postgres reads | 11,612/s | 1 | ~11,600 jobs/s |
| **Postgres writes** | **3,591/s** | **3** | **~1,197 jobs/s** |

The bottleneck is Postgres commit throughput — three durable writes per job (claim, effect row,
terminal status). Adding workers past that point produces more in-flight jobs and longer queue
waits, not more completed work.

---

## Retries and the dead-letter queue

A handler that throws is retried with exponential backoff and jitter, up to `max_attempts` (5).
After that the job becomes `dead` and waits in the dead-letter queue for a human.

```text
attempt 1 fails ──▶ wait ~2s ──▶ 2 fails ──▶ ~4s ──▶ 3 ──▶ ~8s ──▶ 4 ──▶ ~16s ──▶ 5 fails ──▶ dead
```

**The job does not wait inside the worker.** Sleeping through a 16-second backoff would hold a
concurrency slot doing nothing, and a worker killed during that sleep would take the retry with it.
Instead the job is parked in a Redis sorted set scored by the epoch-ms it becomes due, the worker's
slot is released immediately, and a separate scheduler promotes it when it comes due — at which point
*any* worker can take it.

**Jitter is not a detail.** 500 jobs that failed in the same second because one receiver went down
would, without jitter, all retry in the same instant — rebuilding the stampede that broke it, at the
moment it was recovering. Each delay carries up to 30% of random spread.

Observed on a real `flaky/3` webhook, delays of 2.2s / 5.0s / 8.5s, succeeding on attempt 4:

```text
[w1] attempt 1/5 failed: responded 503 — retry in 2.2s
[w1] attempt 2/5 failed: responded 503 — retry in 5.0s
[w1] attempt 3/5 failed: responded 503 — retry in 8.5s
[w1] delivered 200 in 6ms
[w1] succeeded                       attempts = 4, job_effects rows = 1
```

Four executions, **one** effect row — a retry must not be counted as a duplicate.

### The dead-letter queue

`status = 'dead'` is the DLQ; there is no separate Redis list, because a second copy of that fact
could disagree with the row that holds the error and the timings.

```bash
curl "http://localhost:4000/api/jobs?status=dead"          # read the inbox
curl -X POST "http://localhost:4000/api/jobs/<id>/replay" \
  -H 'Authorization: Bearer <your key>'                    # fix the cause, then replay
```

A DLQ is an inbox, not a graveyard. Replay resets the attempt counter, because the retries that were
exhausted were spent against conditions that have since been fixed. Replaying a job that is not dead
returns `409`.

### Watching the backoff

```bash
npm run redis:cli -- zrange queueflow:delayed 0 -1 WITHSCORES
```

```sql
SELECT attempts, status, next_run_at, left(last_error, 60) FROM jobs
 WHERE status = 'retrying' ORDER BY next_run_at;
```

---

## Surviving a dead worker

Retries handle a handler that *throws*. They do nothing for a worker that stops existing — that code
never runs. This is the other half, and it is three mechanisms that only work together.

**1 · The job is never in transit.** `BLMOVE` pops from `pending` and pushes onto
`queueflow:processing:<workerId>` in one atomic step. Kill the process and the id is still in Redis,
on a key naming the worker that was holding it. It is released with `LREM` *after* the outcome is
recorded, never before — so a crash in that window means the job runs again, which is the direction
worth failing in.

**2 · The heartbeat is a key that deletes itself.** Every 10s a worker runs
`SET worker:<id>:alive <pid> EX 30`. A living worker keeps refreshing it; a dead one stops, and Redis
removes it. **Nothing has to notice the death** — there is no monitor and no timeout bookkeeping, the
absence of a key *is* the notification.

**3 · The reaper puts the work back.** The scheduler scans for processing lists whose owner has no
heartbeat, resets those rows to `queued`, and moves the ids back to `pending`.

```text
worker w1 ──BLMOVE──▶ holds job, beats every 10s
    │
  kill -9                       job id still in queueflow:processing:w1
    │                           row still says 'running'
    ▼
  ~30s   worker:w1:alive expires by itself
    │
    ▼
 reaper  sees a processing list with no live owner
    │    row ─▶ 'queued', then LMOVE the id back to pending
    ▼
worker w2 picks it up and finishes it
```

### The part that cannot be fixed

**A missing heartbeat means "has not spoken recently", not "is dead".** A long garbage-collection
pause, a stalled network, a machine briefly starved of CPU — all identical from the outside. So the
reaper will sometimes take a job from a worker that is alive and about to finish, and the job runs
twice. Tuning the TTL trades one failure for the other; nothing removes it, because over a network
*dead* and *slow* are the same observation.

**So a second execution is made harmless rather than prevented.** Claiming a job stamps a random
`lease_id` on the row, and every write-back carries `AND lease_id = <mine>`. A worker whose job was
reassigned finds its lease revoked, matches zero rows, writes no effect row, and says so:

```text
[w1] job_9f2c1a4e  fenced out — finished the work, but the lease was reissued while it ran
[w2] job_9f2c1a4e  succeeded                                    job_effects rows = 1
```

It is a Postgres column rather than a Redis key with a TTL on purpose: the obvious alternative
expires during exactly the slow execution that caused the problem, and a constraint does not expire.

### What that does and does not buy

Run the same collision twice, once with `FENCING=off`:

| | `FENCING=off` | `FENCING=on` |
| --- | --- | --- |
| rows in `job_effects` | **2** | **1** |
| webhook deliveries received | 2 | **2** |
| deliveries actually applied | 2 | **1** — by the receiver |

The middle row does not improve, and that is the honest limit. By the time the reaper moved the job,
the first worker had already sent its request; nothing on this side can recall it. Only the receiver
can absorb the repeat, which `/hook/idempotent` does by remembering the `X-QueueFlow-Job-Id` it has
already handled.

> Exactly-once delivery is impossible. At-least-once delivery plus an idempotent consumer produces an
> exactly-once **effect**.

`test/crash.test.ts` asserts all three numbers. `test/chaos.test.ts` kills random workers across
eight rounds of 40 jobs and ends with nothing lost and nothing duplicated.

### Watching it happen

```bash
curl http://localhost:4000/api/workers                              # who is alive, and holding what
npm run redis:cli -- lrange queueflow:processing:w1 0 -1            # what w1 has right now
npm run redis:cli -- ttl worker:w1:alive                            # seconds until presumed dead
```

Kill a worker mid-job and watch the TTL count down to `-2`, `alive` flip to false while the jobs are
still listed against it, and then the jobs move back to `pending`.

---

## Job lifecycle

```text
  queued ──▶ running ──┬──▶ succeeded
                ▲      │
                │      ├──▶ retrying ──▶ (back to queued when due)
                │      │         └──▶ dead   (attempts exhausted)
                │      │
                └──────┴──▶ back to queued, by the reaper, when the worker
                            holding it stops heartbeating
```

Enforced by a `CHECK` constraint in [db/schema.sql](db/schema.sql), so an invalid status fails at
the write rather than creating a state nothing queries for.

`retrying` is distinct from `queued` on purpose: a `queued` job is in Redis and will run as soon as
a worker is free, while a `retrying` job is in nobody's queue yet. `failed` remains permitted but is
no longer written — it is the slot for a permanent, non-retryable failure if error classification is
ever added.

Three timestamps are recorded because they answer different questions:

```sql
started_at   - created_at   -- queue wait: a property of this system
completed_at - started_at   -- execution time: a property of the work
```

Conflating them is the standard benchmarking mistake.

---

## Verifying correctness

`job_effects` records one row per execution. Nothing in the system reads it — it exists so that
correctness is a query rather than an argument about log files. Both of these must return zero rows:

```sql
-- did any job run more than once?
SELECT job_id, COUNT(*) FROM job_effects GROUP BY job_id HAVING COUNT(*) > 1;

-- did any job claim success without running?
SELECT id FROM jobs WHERE status = 'succeeded'
  AND id NOT IN (SELECT job_id FROM job_effects);
```

Open a psql shell with `npm run db:psql`.

### Watching Redis

`npm run redis:monitor` streams every command the server receives, which is the clearest way to see
the handoff actually happen:

```text
"LPUSH"  "queueflow:pending" "26c98da8-..."
"BLMOVE" "queueflow:pending" "queueflow:processing:w1" "RIGHT" "LEFT" "0"
"SET"    "worker:w1:alive" "48212" "EX" "30"
"LREM"   "queueflow:processing:w1" "1" "26c98da8-..."
```

The whole lifecycle is visible: the job moves between two lists rather than vanishing into a process,
and the heartbeat ticks alongside it.

---

## Current limitations

Tracked per milestone in [gaps/](gaps/), each with the reason it was left and a query that
demonstrates it. In summary:

- **A duplicate side effect is still possible.** The lease guarantees one *record* per job, not one
  delivery. A worker fenced out at commit time had already sent its request; only the receiver can
  absorb the repeat.
- **Recovery takes as long as the heartbeat TTL** — up to 30s before a dead worker's jobs move. Safe
  the whole time, but not moving. Shortening it means robbing healthy workers more often.
- **No graceful shutdown** — `SIGTERM` is not handled, so an ordinary deploy is indistinguishable
  from a crash and goes through the reaper. With three workers at `CONCURRENCY=20` that is up to
  sixty jobs re-run per release.
- **Every error is treated as retryable** — a `400` burns all five attempts.
- **The scheduler is a single point of failure**, and a silent one: it now carries the reaper too, so
  if it stops, neither retries nor crashed jobs come back and nothing reports it. Running two is safe.
- **Two processes sharing a `WORKER_ID` degrade quietly.** The dangerous case is blocked and logged,
  but per-worker attribution becomes meaningless.
- **No ordering guarantee** once concurrency is above 1; jobs start FIFO but finish in any order.
- **No rate limiting toward downstream services**, and one shared slot pool for all job types.
- **Idempotency keys never expire** — real implementations scope them to a window.
- **API keys live in an env var**, not a table: no per-client naming, no revocation, no last-used
  timestamp, no expiry, and no rate limiting. Right size for a couple of machine clients; fifty
  would want an `api_keys` table with hashed values.

## Roadmap

Dashboard: DLQ with replay, a submit form, and operator login · graceful shutdown on `SIGTERM` ·
error classification so a `400` is not retried · containerised deployment with CI.

---

## Layout

```text
db/schema.sql        tables, constraints, indexes
gaps/                known limitations, per milestone
src/
  shared/
    db.ts            Postgres pool + parameterised query helper
    redis.ts         Redis connection factory
    keys.ts          Redis key names, defined once
    types.ts         job shape, lifecycle states, row mapping, validation
    log.ts           traceable per-job log format
    semaphore.ts     counting semaphore bounding in-flight jobs per worker
    retry.ts         backoff policy: exponential, capped, jittered
    heartbeat.ts     the "still alive" key, and its TTL
  db/migrate.ts      applies db/schema.sql
  api/index.ts       HTTP producer; serves the dashboard when web/dist exists
  worker/
    index.ts         consumer loop, handoff, leases, lifecycle transitions
    handlers.ts      job type implementations
  scheduler/
    index.ts         returns jobs to pending — due retries, and lost work
    reaper.ts        dead-worker recovery and the orphan sweep
  receiver/index.ts  test webhook receiver, for local development only
  dev/
    workers.ts       spawn N workers in one terminal
    bench.ts         throughput sweep
test/
  concurrency.test.ts  no two workers take the same job
  retry.test.ts        backoff, the DLQ, and replay
  backoff.test.ts      the delay function, in isolation
  crash.test.ts        kill -9 mid-job; the lease, with and without
  chaos.test.ts        random kills under load; nothing lost, nothing duplicated
web/                   the dashboard — Vite + React, its own package
  src/
    api/               one file per API resource; client.ts is the fetch wrapper
    pages/             one component per route
    types.ts           the API's JSON shapes as the browser sees them
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run up` / `down` | Start / remove Redis and Postgres |
| `npm run db:migrate` | Apply the schema |
| `npm run db:psql` | psql shell |
| `npm run key:new` | Print a fresh API key to paste into `.env` |
| `npm run dev:api` / `dev:worker` | Run with watch-reload |
| `npm run dev:workers 3` | Run N workers in one terminal, output prefixed per worker |
| `npm run dev:scheduler` | Scheduler — due retries, dead-worker recovery, orphan sweep |
| `npm run dev:receiver` | Local webhook receiver on :4001 for testing deliveries |
| `npm run dev:web` | Dashboard dev server on :5173, proxying `/api` to :4000 |
| `npm run build:web` | Build the dashboard to `web/dist` for the API to serve |
| `npm test` | 18 tests against real processes: concurrency, retries, crashes, chaos |
| `npm run bench` | Throughput sweep across workers × concurrency |
| `npm run redis:cli` / `redis:monitor` | Inspect Redis |
| `npm run typecheck` | `tsc --noEmit` |
