# Gaps — Phase 2 (persistence)

Deliberate omissions. Each one is a thing that could have been built and was not, with the reason
and a way to observe it — so it is a demonstrable fact rather than a claim.

| ID | Gap | Closed by |
| --- | --- | --- |
| GAP-2.1 | Orphaned `queued` rows — crash between the insert and the push, no sweeper | **closed** — orphan sweep |
| GAP-2.2 | Jobs stick at `running` forever when a worker dies | **closed** — handoff, heartbeat, reaper |
| GAP-2.3 | No retry, backoff or dead-letter queue; a failure is terminal | Phase 4 |
| GAP-2.4 | `job_effects` is written on success only | still open — see GAP-5.1 |
| GAP-2.5 | `max_attempts` and `idempotency_key` exist but are unused | **closed** — both now used |
| GAP-2.6 | No graceful shutdown | Phase 7 |

---

## GAP-2.1 — Orphaned `queued` rows, and no sweeper

**What.** `POST /jobs` performs two writes to two different stores:

```
INSERT INTO jobs (...) VALUES (..., 'queued')     -- Postgres
LPUSH queueflow:pending <id>                       -- Redis
```

No transaction spans both — there is no such thing. If the API process dies between them, the row
says `queued` and no worker will ever see the id. The job waits forever.

**Why left.** The whole value of insert-then-push is that this wreckage is *findable*. One query
proves it, with no daemon required. A real sweeper has to distinguish "queued and legitimately
waiting in Redis" from "queued and lost", which needs a per-job membership check against the
pending list — the same machinery the Phase 5 reaper already has to build. Building it twice is
worse than building it once, later.

**How to see it.** Simulate the crash by doing only the first write:

```bash
npm run db:psql -- -c "INSERT INTO jobs (id, type, payload, status)
  VALUES (gen_random_uuid(), 'sleep', '{\"ms\":1000}', 'queued')"
```

Now find the orphan — nothing ran it, and nothing ever will:

```sql
SELECT id, type, created_at FROM jobs
 WHERE status = 'queued' AND created_at < now() - interval '1 minute';
```

Compare with the reversed write order, which would have produced a worker holding an id with no
row behind it: nothing to query, nothing to recover, no record the job existed. **An orphan you
can find beats a ghost you cannot.**

**Closed.** `sweepOrphans` in `src/scheduler/reaper.ts` runs this same question every few seconds and
pushes what it finds. It was held back until leases existed: re-pushing an id risks running a job
twice, and that was only worth doing once a second run could not corrupt the record.

---

## GAP-2.2 — Jobs stick at `running` when a worker dies

**What.** The worker sets `status='running'` and then executes. If the process is killed mid-job,
nothing sets a terminal status. The row stays `running` forever, and the id is already gone from
Redis because `BRPOP` removed it at handoff.

**Why left.** Fixing it needs a way to tell a dead worker from a slow one, which needs heartbeats,
a TTL and a reaper — and then, unavoidably, idempotency, because a timeout-based failure detector
is eventually wrong about a living process. That is the whole of Phase 5, and it does not decompose
into something smaller worth shipping here.

**How to see it.** Enqueue a 20s sleep, wait for `started`, hard-kill the worker, then:

```sql
SELECT id, status, started_at, completed_at FROM jobs
 WHERE status = 'running' AND started_at < now() - interval '1 minute';
```

**This is the Phase 2 payoff.** In Phase 1 the identical crash left nothing at all — no key, no
row, no evidence. The job is still lost, but it is now visible, and that stuck row is precisely
what the Phase 5 reaper will hunt for.

**Closed.** `BLMOVE` into a per-worker processing list, a heartbeat key with a TTL, and a reaper in
the scheduler. The stuck row is now the reaper's cue rather than the only evidence — see
`test/crash.test.ts`, which kills a worker mid-job and asserts the job comes back and runs once.

---

## GAP-2.3 — No retry, backoff or dead-letter queue

**What.** A handler that throws sets `status='failed'` and `last_error`, and the job stops there.
A network blip that would have succeeded on the second attempt is treated exactly like a permanent
bug.

**Why left.** Phase 4. Retries without backoff and jitter turn one downstream outage into a
self-inflicted stampede, so it is worth building deliberately rather than bolting on an `if`.

**How to see it.**
```bash
curl -X POST http://localhost:4000/jobs -H 'Content-Type: application/json' \
  -d '{"type":"always_fail","payload":{}}'
```
The row lands at `failed` with `attempts = 1` and never moves again.

**Closed by.** Phase 4.

---

## GAP-2.4 — `job_effects` is written on success only

**What.** The effect row is inserted in the same transaction as `status='succeeded'`. A job that
crashes halfway through its handler leaves no effect row — even though a real handler might already
have charged a card or sent an email by then.

**Why left.** It is the honest cost of a completion-time write, and the alternative has its own
lie: inserting at start would claim an effect for a job that threw on its first line. The right
answer is for the handler to record its own effect at the moment it causes one, which only becomes
meaningful in Phase 5 when idempotency makes "did this already happen?" a question the system
actually asks.

**Impact on the correctness queries.** Both still hold for completed jobs, which is what they are
used for:

```sql
SELECT job_id, COUNT(*) FROM job_effects GROUP BY job_id HAVING COUNT(*) > 1;  -- ran twice?
SELECT id FROM jobs WHERE status = 'succeeded'
  AND id NOT IN (SELECT job_id FROM job_effects);                              -- never ran?
```

**Still open.** Leases made "did this already happen?" answerable for the RECORD, which is what the
correctness queries read, and that turned out to be the useful half. Moving the effect row into the
handler — recorded at the moment the side effect happens rather than when the job completes — was
not built, and the reason it still would not be enough is GAP-5.1: the row would say a webhook was
sent, and the webhook would already have been sent twice regardless.

---

## GAP-2.5 — `max_attempts` and `idempotency_key` are unused

**What.** Both columns exist in `db/schema.sql`, including the `UNIQUE` constraint on
`idempotency_key`. Nothing reads or writes either one yet.

**Why left.** Declared now on purpose. They belong to the schema this system was specified with,
and adding columns to a table that already has history is churn. The `UNIQUE` constraint in
particular is the durable half of Phase 5's idempotency — Redis keys expire, a database constraint
does not — so having it in place from the start is deliberate.

**Closed.** `max_attempts` bounds retries and now also bounds how many times the reaper will rescue a
job that keeps killing its worker. `idempotency_key` is read from the `Idempotency-Key` header on
`POST /jobs`, and the `UNIQUE` constraint declared here three phases early is what decides a duplicate
submission — exactly the use it was reserved for.

---

## GAP-2.6 — No graceful shutdown

**What.** `SIGTERM` or `Ctrl+C` kills the worker immediately, including mid-job. Every deploy
therefore destroys whatever was in flight and leans on recovery machinery that does not exist yet.

**Why left.** Phase 7. It is a small change — stop taking new work, finish the current job, exit —
but it is only honest once there is something to fall back on when it fails.

**How to see it.** `Ctrl+C` a worker mid-job: the row stays `running`, same as GAP-2.2.

**Closed by.** Phase 7.
