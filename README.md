# QueueFlow

A distributed background job queue built directly on Redis primitives — no BullMQ, Bee-Queue or
Agenda. The handoff protocol, lifecycle tracking, failure recording and recovery machinery are
implemented here rather than delegated, so the policy decisions stay explicit and reviewable.

An HTTP API accepts work and returns immediately. Separate worker processes consume and execute it.
Redis carries job ids between them; Postgres holds the payloads, outcomes and timings.

---

## Architecture

```
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
| `sleep` | `{ ms: number }` | Waits, then succeeds |
| `always_fail` | `{ message?: string }` | Throws. A test fixture for the failure path |

---

## Job lifecycle

```
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

```
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
- **One job in flight per worker**, and no concurrency controls.
- **No graceful shutdown** — `SIGTERM` kills in-flight work.

## Roadmap

Concurrency across multiple workers · retries with exponential backoff, jitter and a dead-letter
queue · atomic pop-and-hold via `BLMOVE` with worker heartbeats, a stalled-job reaper and
idempotency keys · a live dashboard · containerised deployment with CI.

---

## Layout

```
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
  worker/
    index.ts         consumer loop and lifecycle transitions
    handlers.ts      job type implementations
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run up` / `down` | Start / remove Redis and Postgres |
| `npm run db:migrate` | Apply the schema |
| `npm run db:psql` | psql shell |
| `npm run dev:api` / `dev:worker` | Run with watch-reload |
| `npm run redis:cli` / `redis:monitor` | Inspect Redis |
| `npm run typecheck` | `tsc --noEmit` |
