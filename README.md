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
                                 │ LPUSH id             ▲   ▲
                                 ▼                      │   │
                        ┌──────────────────┐            │   │
                        │ queueflow:pending│  Redis LIST│   │
                        └──────────────────┘            │   │
                                 │                      │   │
                              BRPOP (blocks)            │   │
                                 ▼                      │   │
                            worker process ─────────────┘   │
                            runs the handler ────────────────┘
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
| `GET /health` | Redis and Postgres reachability, queue depth, status tally |

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

## Job lifecycle

```text
  queued ──▶ running ──┬──▶ succeeded
                       └──▶ failed
```

Enforced by a `CHECK` constraint in [db/schema.sql](db/schema.sql), so an invalid status fails at
the write rather than creating a state nothing queries for.

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
- **No retry, backoff or dead-letter handling.** A failure is terminal.
- **A crash between the insert and the enqueue leaves an unrunnable `queued` row.** Findable by
  query; no automatic sweeper yet.
- **A killed worker now strands up to `CONCURRENCY` jobs**, not one — concurrency multiplies the
  blast radius of the gap above.
- **No ordering guarantee** once concurrency is above 1; jobs start FIFO but finish in any order.
- **No rate limiting toward downstream services**, and one shared slot pool for all job types.
- **No graceful shutdown** — `SIGTERM` kills in-flight work.

## Roadmap

Concurrency across multiple workers · retries with exponential backoff, jitter and a dead-letter
queue · atomic pop-and-hold via `BLMOVE` with worker heartbeats, a stalled-job reaper and
idempotency keys · a live dashboard · containerised deployment with CI.

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
  worker/
    index.ts         consumer loop and lifecycle transitions
    handlers.ts      job type implementations
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
| `npm run dev:receiver` | Local webhook receiver on :4001 for testing deliveries |
| `npm test` | Concurrency proof — 3 workers, 100 jobs, zero duplicates |
| `npm run bench` | Throughput sweep across workers × concurrency |
| `npm run redis:cli` / `redis:monitor` | Inspect Redis |
| `npm run typecheck` | `tsc --noEmit` |
