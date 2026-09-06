# QueueFlow

A distributed background job queue built directly on Redis primitives — no BullMQ, Bee-Queue or
Agenda. The handoff protocol, lifecycle tracking, failure recording and recovery machinery are
implemented here rather than delegated, so the policy decisions stay explicit and reviewable.

An HTTP API accepts work and returns immediately. Separate worker processes consume and execute it.
Redis carries job ids between them; Postgres holds the payloads, outcomes and timings.

---

## Architecture

```text
   client ──POST /jobs──▶  Express API ──INSERT──▶ ┌────────────┐
                            (:4000)                │  Postgres  │  jobs, job_effects
                                 │                 └────────────┘
                                 │ LPUSH id             ▲    ▲
                                 ▼                      │    │
                        ┌──────────────────┐            │    │
                        │ queueflow:pending│  LIST      │    │
                        └──────────────────┘            │    │
                             ▲           │              │    │
                 LPUSH when  │        BRPOP (blocks)    │    │
                        due  │           ▼              │    │
                    ┌────────────┐   worker process ────┘    │
                    │ scheduler  │   runs the handler ───────┘
                    └────────────┘        │
                             ▲            │ ZADD on failure
              ZRANGEBYSCORE  │            ▼
                  + ZREM     │   ┌──────────────────┐
                             └───│ queueflow:delayed│  ZSET, scored by run-at
                                 └──────────────────┘
```

**Why both stores.** Redis is fast and volatile, and is used only as a transport — it holds job ids
and nothing else. Postgres is the permanent record: it answers "what happened to job X", "what is
still queued", and "how long do jobs wait before they start". Redis alone cannot answer any question
about a job it has already handed out.

**Write ordering.** The two stores cannot be written atomically — no transaction spans them. The row
is inserted *before* the id is pushed, so a crash between the two leaves a `queued` row that a query
can find, rather than a worker holding an id for a job that was never recorded. An orphan you can
find beats a ghost you cannot.

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
npm run dev:api
npm run dev:worker
```

### Submitting work

```bash
curl -X POST http://localhost:4000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"sleep","payload":{"ms":5000}}'
```

```json
{ "jobId": "26c98da8-4a12-45f1-8596-05f41448a898", "status": "queued" }
```

`202 Accepted`, not `200 OK` — the work has not been done, and the API never observes its outcome.

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /jobs` | Submit work. Returns `202` with the job id |
| `GET /jobs/:id` | Full record: status, attempts, error, timings |
| `GET /jobs?status=&limit=` | Recent jobs, newest first |
| `POST /jobs/:id/replay` | Requeue a dead job. `409` unless it is dead |
| `GET /health` | Redis and Postgres reachability, pending/delayed depth, status tally |

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
| `POST /hook/down` | Always returns 500 |
| `POST /hook/slow` | Holds the connection open for 60s |
| `POST /hook/flaky/:n` | Fails the first `n` deliveries of each job, then succeeds |
| `GET /deliveries` | What actually arrived, counted per job |

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
curl "http://localhost:4000/jobs?status=dead"          # read the inbox
curl -X POST "http://localhost:4000/jobs/<id>/replay"  # fix the cause, then replay
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

## Job lifecycle

```text
  queued ──▶ running ──┬──▶ succeeded
                       │
                       └──▶ retrying ──▶ (back to queued when due)
                                └──▶ dead   (attempts exhausted)
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
"BRPOP"  "queueflow:pending" "0"
```

---

## Current limitations

Tracked per milestone in [gaps/](gaps/), each with the reason it was left and a query that
demonstrates it. In summary:

- **Delivery is not guaranteed across worker failure.** `BRPOP` removes the id at handoff, so a
  worker killed mid-job loses the job. The row is left at `running` — visible, but not recovered.
- **Retries cover handlers that threw, not workers that died.** A killed worker still strands its
  job at `running` with no retry scheduled.
- **Every error is treated as retryable** — a `400` burns all five attempts.
- **The retry scheduler is a single point of failure**, and a silent one: if it stops, `retrying`
  jobs never return and nothing reports it. Running two is safe.
- **Retrying a job whose outcome is unknown (a timeout) can duplicate a side effect.**
- **A crash between the insert and the enqueue leaves an unrunnable `queued` row.** Findable by
  query; no automatic sweeper yet.
- **A killed worker now strands up to `CONCURRENCY` jobs**, not one — concurrency multiplies the
  blast radius of the gap above.
- **No ordering guarantee** once concurrency is above 1; jobs start FIFO but finish in any order.
- **No rate limiting toward downstream services**, and one shared slot pool for all job types.
- **No graceful shutdown** — `SIGTERM` kills in-flight work.

## Roadmap

Atomic pop-and-hold via `BLMOVE` with worker heartbeats, a stalled-job reaper and idempotency keys ·
a live dashboard · containerised deployment with CI.

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
  db/migrate.ts      applies db/schema.sql
  api/index.ts       HTTP producer
    semaphore.ts     counting semaphore bounding in-flight jobs per worker
    retry.ts         backoff policy: exponential, capped, jittered
  worker/
    index.ts         consumer loop and lifecycle transitions
    handlers.ts      job type implementations
  scheduler/index.ts promotes delayed jobs back to pending when due
  receiver/index.ts  test webhook receiver, for local development only
  dev/
    workers.ts       spawn N workers in one terminal
    bench.ts         throughput sweep
test/                integration tests against real Redis and Postgres
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run up` / `down` | Start / remove Redis and Postgres |
| `npm run db:migrate` | Apply the schema |
| `npm run db:psql` | psql shell |
| `npm run dev:api` / `dev:worker` | Run with watch-reload |
| `npm run dev:workers 3` | Run N workers in one terminal, output prefixed per worker |
| `npm run dev:scheduler` | Retry scheduler — promotes delayed jobs when due |
| `npm run dev:receiver` | Local webhook receiver on :4001 for testing deliveries |
| `npm test` | Concurrency proof — 3 workers, 100 jobs, zero duplicates |
| `npm run bench` | Throughput sweep across workers × concurrency |
| `npm run redis:cli` / `redis:monitor` | Inspect Redis |
| `npm run typecheck` | `tsc --noEmit` |
