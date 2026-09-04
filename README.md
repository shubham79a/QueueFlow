# QueueFlow

A distributed background job queue, built on raw Redis primitives — no BullMQ, no
Bee-Queue, no Agenda. The retry scheduler, backoff policy, dead-letter queue,
heartbeat protocol, orphan reaper and idempotency layer are the project; a queue
library would be a wrapper around someone else's answers to all of them.

> **Status: Phase 1 of 7.** A producer, a queue, and one consumer. No persistence,
> no retries, no reliability machinery — those are Phases 2, 4 and 5, and each one
> exists to fix a failure this phase can demonstrate.

---

## Phase 1 architecture

```
  curl ──POST /jobs──▶  Express API  ──LPUSH──▶  ┌──────────────────┐
                        (port 4000)              │ queueflow:pending│  Redis LIST
                                                 └──────────────────┘
                                                          │
                                                        BRPOP  (blocks)
                                                          │
                                                          ▼
                                                    Worker process
                                                    runs the handler
```

Two OS processes. They never import each other and share no memory — the only
thing connecting them is a Redis list and an agreement on its name.

`LPUSH` writes to the head, `BRPOP` reads from the tail. Opposite ends is what
makes the list FIFO rather than a stack.

---

## Running it

**Prerequisites:** Node ≥ 22, Docker Desktop running.

```bash
npm install
cp .env.example .env      # optional — every value has a default in code
npm run redis:up          # docker compose up -d
```

Then three terminals:

| Terminal | Command |
| --- | --- |
| A | `npm run dev:api` |
| B | `npm run dev:worker` |
| C | `npm run redis:monitor` |

Terminal C is the one worth having. `redis-cli MONITOR` prints every command the
server receives, so you watch the job move rather than infer it from logs.

**Enqueue a job** (Git Bash / WSL — in PowerShell use `curl.exe`, since `curl`
there is an alias for `Invoke-WebRequest`):

```bash
curl -X POST http://localhost:4000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"sleep","payload":{"ms":5000}}'
```

```json
{ "jobId": "a1b2c3d4-...", "status": "queued" }
```

**202 Accepted, not 200 OK.** 200 means "here is the result of what you asked for",
and there is no result — the work has not started. 202 means "I have taken
responsibility for this and I am not done", which is exactly true.

---

## Inspecting Redis by hand

```bash
npm run redis:cli llen queueflow:pending          # queue depth
npm run redis:cli lrange queueflow:pending 0 -1   # everything waiting
npm run redis:cli ping
```

---

## Phase 1 acceptance checks

1. **Round trip.** Enqueue one job → API returns `202` → terminal C shows `LPUSH`
   then the worker's `BRPOP` → terminal B logs `started` … 5s … `finished`.
2. **Drain.** Enqueue 5 jobs, wait ~25s, then `llen queueflow:pending` → `0`.
   They run one at a time, in order — that ceiling is what Phase 3 removes.
3. **The queue holds state, not the worker.** Stop the worker. Enqueue 3 jobs; the
   API still returns 202 and `llen` climbs to 3. Start the worker — it drains all
   three. The producer never needed a consumer to exist.
4. **Health reflects the dependency.** `curl http://localhost:4000/health` → 200.
   `npm run redis:down`, call it again → 503.

---

## Now break it — this is the actual deliverable

Phase 1 is built the naive way on purpose. Do this before moving on:

```bash
# 1. Enqueue a 20-second job
curl -X POST http://localhost:4000/jobs -H 'Content-Type: application/json' \
     -d '{"type":"sleep","payload":{"ms":20000}}'

# 2. Confirm the worker has picked it up (terminal B logs "started")

# 3. Kill the worker — Ctrl+C in terminal B, or from another shell:
#    taskkill /F /PID <pid>     (Windows)

# 4. Ask Redis where the job went:
npm run redis:cli llen queueflow:pending      # -> 0
npm run redis:cli keys '*'                    # -> (empty array)
```

**The job is gone.** Not failed — gone. `BRPOP` removed it from Redis the instant
the worker took it, so the only copy lived in that dead process's memory. There is
no row, no log entry, no key, and no way for anyone to discover that a job was
accepted and never ran. The API already told the client `202`.

Two distinct problems, and they are what the next phases are for:

| What's missing | Phase |
| --- | --- |
| No record the job ever existed → nowhere to look | 2 — Postgres |
| Redis forgot it the moment it was handed out | 5 — `BLMOVE` + reaper |

Restarting the worker does not help. That is the point.

---

## Deliberately not built yet

Each of these removes a failure that motivates a later phase, so building it early
costs more than it saves.

- **No Postgres.** The job payload currently rides inside the Redis list entry.
  `project.md`'s key layout ("Redis holds ids, Postgres holds data") is the Phase 2
  shape; splitting them *is* Phase 2's work.
- **No `GET /jobs/:id`.** You will want it immediately and you cannot build it — a
  job inside a Redis list has no address. Feeling that is the point.
- **No retries, backoff, delayed ZSET or DLQ** → Phase 4. A thrown handler logs and
  the job dies.
- **No `BLMOVE`, heartbeat, reaper or idempotency** → Phase 5.
- **No graceful shutdown** → Phase 7. Ctrl+C during a job kills it mid-flight.
- **No concurrency.** One job at a time per worker: the loop cannot return to
  `BRPOP` until the handler resolves → Phase 3.

---

## Layout

```
src/
  shared/
    keys.ts      Redis key names, defined once — a typo here is a silent bug
    types.ts     Job shape + parseJob(), the runtime check at the trust boundary
    log.ts       [w1] job_a1b2 ... — one job traceable across processes
    redis.ts     connection factory (one connection per blocking call)
  api/
    index.ts     POST /jobs, GET /health
  worker/
    index.ts     the BRPOP loop
    handlers.ts  job types — currently just `sleep`
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev:api` | API with watch-reload |
| `npm run dev:worker` | Worker with watch-reload |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run redis:up` / `redis:down` | Start / remove the Redis container |
| `npm run redis:cli` | `redis-cli` inside the container |
| `npm run redis:monitor` | Live stream of every Redis command |
