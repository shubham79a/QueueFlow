# QueueFlow

A distributed background job queue built directly on Redis primitives — no BullMQ, Bee-Queue or
Agenda. The handoff protocol, lifecycle tracking, failure recording and recovery machinery are
implemented here rather than delegated, so the policy decisions stay explicit and reviewable.

An HTTP API accepts work and returns immediately. Separate worker processes consume and execute it.
Redis carries job ids between them; Postgres holds the payloads, outcomes and timings. A job survives
the death of the process running it: `kill -9` a worker mid-job and the job comes back on its own —
and a dashboard, served by the API, lets you watch that happen.

**Running at [queueflow-ph5g.onrender.com](https://queueflow-ph5g.onrender.com)** with seeded data.
On the free tier all three processes share one container, so `--scale worker=3` is not available
there; [`docker-compose.prod.yml`](docker-compose.prod.yml) is the real shape.

**More detail:** [API reference](docs/api.md) · [Internals](docs/internals.md) ·
[Known gaps](gaps/)

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

A React app in [web/](web/) that shows the system as it runs. Reading is open to anyone:

| Page | Shows |
| --- | --- |
| **Jobs** — `/jobs` | recent jobs with a status filter — queue wait and run time per row, refreshing every 2 s |
| **Job detail** — `/jobs/<id>` | one job: payload, attempts, error, all three timestamps, the next retry if it is backing off |
| **Workers** — `/workers` | every worker from its heartbeat key — alive or gone, TTL counting down, what it is holding. Kill a worker mid-job and watch its row turn red, then empty as the reaper takes over |
| **DLQ** — `/dlq` | jobs that exhausted their attempts, each with its error and a **Replay** button |
| **Health strip** | in the header: Redis and Postgres up or down, queue depth, jobs by status |

The status filter lives in the URL, so `/jobs?status=dead` is a link you can send someone and the
back button undoes a filter. It is a query parameter rather than `/jobs/dead` because `/jobs/<id>`
already means one job, and a path segment could not tell a status from an id.

Signing in with the operator password unlocks the two actions that write: **New job** on the Jobs
page, and **Replay** in the DLQ. Everything else stays readable signed out — the buttons are shown
disabled rather than hidden, so a visitor can see what exists.

**The demo, end to end, without a terminal:** sign in → New job → type `deliver_webhook`, url
`http://127.0.0.1:9999/nowhere` → Create. Watch the row go `running` → `retrying` with the backoff
counting down on its detail page → five attempts → `dead`. Open the DLQ, read the error, press
Replay, and watch it start over with `attempts` back to zero.

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

### Running it from containers

`docker-compose.prod.yml` starts the whole system — both stores, a one-shot migration, and the
three application processes — with no Node installed on the host:

```bash
cp .env.example .env      # set API_KEYS or ADMIN_PASSWORD, and SESSION_SECRET
docker compose -f docker-compose.prod.yml up -d --build
```

The dashboard is then at <http://localhost:4000>, served by the API container.

**One image, three roles.** `api`, `worker` and `scheduler` are the same build; only the `command:`
differs. Running three copies of one image is what keeps them in step, and it is the same shape a
PaaS expects — a process group per role, one artifact.

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

Workers need distinct ids, because the id names the Redis key holding that worker's in-flight jobs.
With `WORKER_ID` unset a worker falls back to its hostname, which in a container is the container
id — so scaling needs no configuration.

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

## Current limitations

Tracked per milestone in [gaps/](gaps/), each with the reason it was left and a query that
demonstrates it. In summary:

- **A duplicate side effect is still possible.** The lease guarantees one *record* per job, not one
  delivery. A worker fenced out at commit time had already sent its request; only the receiver can
  absorb the repeat.
- **Recovery from an *unplanned* death takes as long as the heartbeat TTL** — up to 30s before a dead
  worker's jobs move. Safe the whole time, but not moving. Shortening it means robbing healthy
  workers more often. A planned stop no longer pays this, since a draining worker deletes its own
  heartbeat.
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
- **One operator password, no users table** — no roles, no reset, no per-person audit trail. Five
  operators would want users with bcrypt and roles.
- **Sessions are stateless.** Nothing is stored server-side, so signing out on one device does not
  end the session on another, and a stolen cookie stays valid until it expires. A session table
  would fix both, at the cost of a lookup per request.
- **The login throttle is per-process and in memory** — it resets on restart and does not add up
  across several API instances.

## Deploying

The image is host-agnostic: anything that can run a container and give it three commands will do.

**What it needs.** A Postgres with a persistent volume — it holds every job that ever ran, and losing
it empties the dashboard. A Redis, **also with a volume, and with AOF on**. That second one is not
obvious and is worth the sentence: Redis holds no job data, but *which worker is holding which job*
exists only as the name of a Redis key, and the reaper finds stranded jobs by scanning those names.
An empty Redis does not lose in-flight work so much as make it invisible — the row sits at `running`
and nothing ever looks at it again. See GAP-5.8; persistence narrows that to losing the volume rather
than any restart, but does not close it. Then the three processes.

**Before it is reachable from anywhere**, set `API_KEYS` or `ADMIN_PASSWORD` (the API warns loudly
at startup when neither is set and the write routes are open), `SESSION_SECRET`, and `TRUST_PROXY=1`
if something terminates TLS in front of it.

**Stopping is graceful, and two settings have to agree.** On `SIGTERM` a worker stops taking new
jobs, finishes the ones it is holding, deletes its own heartbeat and exits — so an ordinary deploy no
longer strands work for the reaper. `SHUTDOWN_TIMEOUT_MS` (25 s) is how long it will wait;
`stop_grace_period` (30 s on the worker in `docker-compose.prod.yml`) is how long the orchestrator
will. **The orchestrator's number must be the larger of the two**, or the worker is killed mid-drain
and the jobs are stranded anyway *with* a heartbeat left behind, which is worse than not draining.
Raise both together if your handlers run long. Anything still unfinished when the timeout hits falls
back to the reaper exactly as before.

**On a VM** — the simplest always-on option — clone, set `.env`, and
`docker compose -f docker-compose.prod.yml up -d`. Everything runs as it does locally.

**On a PaaS**, build the one image and run three process groups from it, pointing `REDIS_URL` and
`DATABASE_URL` at managed instances. Anything that sleeps when idle is a poor fit: a sleeping worker
is a queue that does not drain.

## Roadmap

Error classification, so a `400` is not retried five times · `worker_id` on the row, so losing Redis
no longer makes in-flight jobs invisible (GAP-5.8) · CI.

---

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
