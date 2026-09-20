# Gaps — Phase 5 (reliable handoff, heartbeats, reaper, leases)

Deliberate omissions. Each says what is missing, why it was left, and how to see it.

**What this phase made worse, first.** Every previous phase left jobs in a dead worker unrecoverable,
which at least meant they were unambiguously gone. Now they come back — and coming back is the same
mechanism as being taken away, so **a job that was never in danger before can now be run twice**. The
lease keeps the *record* single. It does nothing about a side effect that has already left the
building. Several of the gaps below are the shape of that trade.

| ID | Gap | Closed by |
| --- | --- | --- |
| GAP-5.1 | A duplicate side effect is still possible; only the record is protected | not planned — the receiver's job |
| GAP-5.2 | Recovery latency is bounded by the heartbeat TTL, not by the failure | not planned — inherent |
| GAP-5.3 | No graceful shutdown, so every ordinary deploy goes through the reaper | Phase 7 |
| GAP-5.4 | The orphan sweep reads the whole pending list when it finds candidates | not planned — measured |
| GAP-5.5 | Two processes sharing a `WORKER_ID` degrade quietly | not planned — documented |
| GAP-5.6 | The reaper inherits the scheduler's single-point-of-failure problem | not planned — run two |
| GAP-5.7 | `Idempotency-Key` records are kept forever | not planned |
| GAP-5.8 | Losing Redis strands every `running` and `retrying` row permanently | not planned — documented |

---

## GAP-5.1 — The duplicate side effect is still possible

**What.** The lease guarantees that one job produces one row in `job_effects`. It does not, and
cannot, guarantee that the outside world was contacted once. When the reaper takes a job from a
worker that was merely slow, that worker has already sent its webhook. The fence stops it *recording*
the result; nothing stops the request that was already delivered.

**Why left.** It is not fixable from this side, and pretending otherwise would be the worst outcome —
a system that claims exactly-once and quietly is not. By the time a duplicate exists, the sender has
lost the ability to recall it. The only party that can make the repeat harmless is the receiver, and
it does so by recognising the `X-QueueFlow-Job-Id` this system stamps on every attempt.

**How to see it.** `test/crash.test.ts`, the last test, asserts all three numbers at once: one effect
row, **two** deliveries, one applied. Or by hand, against the receiver:

```bash
npm run dev:receiver
# enqueue a slow webhook, kill and rescue the worker mid-flight, then:
curl.exe http://localhost:4001/deliveries
```

`total` climbs with every duplicate; `applied` does not, because `/hook/idempotent` remembers the id.

**The sentence.** *Exactly-once delivery is impossible. At-least-once delivery plus an idempotent
consumer produces an exactly-once effect.* The middle term is the one a queue cannot supply.

---

## GAP-5.2 — Recovery is as slow as the heartbeat TTL

**What.** A job held by a worker that dies cannot come back until that worker's heartbeat has expired
and the reaper has run: at the defaults, up to 30 seconds plus a reap interval. The job is safe the
whole time, but it is not moving.

**Why left.** This is the trade the TTL *is*, not a shortcoming of the implementation. Shorten it and
recovery is faster, but a healthy worker that pauses for a moment gets robbed more often — which
means more duplicate executions, and more work thrown away by the fence. Lengthen it and the reverse.
There is no setting that is fast and never wrong, because "dead" and "slow" are the same observation.

**How to see it.** Kill a worker mid-job and watch:

```bash
docker compose exec redis redis-cli ttl worker:w1:alive
```

Nothing at all happens until that reaches `-2`.

**If it needed tightening.** A worker being shut down deliberately could `DEL` its own heartbeat on
`SIGTERM`, making a planned restart recover instantly while leaving the TTL long for real crashes.
That is most of GAP-5.3.

---

## GAP-5.3 — No graceful shutdown

**What.** `SIGTERM` is not handled. Stopping a worker is the same event as a crash: whatever it was
holding waits out the heartbeat TTL and is then rescued by the reaper and run again from the start.

**Why left.** It is a different concern from surviving a crash, and doing it properly means stopping
new work, draining in-flight jobs, releasing the processing list and clearing the heartbeat — which
is a small phase of its own rather than a footnote to this one. The `Semaphore` already exposes
`inFlight` for it.

**Why it matters more than it sounds.** A deploy restarts every worker at once. With `CONCURRENCY=20`
across three workers, an ordinary release currently strands and re-runs up to sixty jobs — through
the recovery path built for hardware failure, at the moment the system is least idle. Carried over
from GAP-3.5 and GAP-2.6.

**How to see it.** Start a worker, enqueue a 30-second sleep, press `Ctrl+C`, and watch the job spend
the TTL in limbo before running again from zero.

---

## GAP-5.4 — The orphan sweep reads the whole pending list

**What.** When `sweepOrphans` finds `queued` rows older than `ORPHAN_AGE_S`, it has to decide whether
each id is genuinely missing or merely waiting, and the only way to ask a Redis list "do you contain
this?" is to read it. On a large backlog that is an `LRANGE` of everything.

**Why left.** It is guarded by a query that returns nothing on a healthy system, so the expensive
half almost never runs. The failure mode it protects against — a crash between the API's insert and
its push — is rare, and the cost only appears when `ORPHAN_AGE_S` is set below real queue wait, which
the config comment warns about.

**How to see it.** Set `ORPHAN_AGE_S=5`, enqueue 50,000 jobs, and watch the scheduler read the whole
list every five seconds.

**If it needed fixing.** Maintain a Redis SET of queued ids alongside the list, and make the check an
`SISMEMBER`. That is a second structure to keep in step with the first, which is exactly the kind of
duplicated state this project avoids elsewhere — worth it only at a scale this does not have.

---

## GAP-5.5 — Two processes sharing a `WORKER_ID` degrade quietly

**What.** `WORKER_ID` now names a Redis key holding in-flight work. Two processes started with the
same value share that list and the same heartbeat.

**Why left.** Partly handled, deliberately not fully. A starting worker waits for an existing
heartbeat to lapse before recovering, and refuses to touch the list if it does not — so the dangerous
case, one process yanking jobs out of another's hands, cannot happen, and it logs loudly. What
remains is milder: both processes run work, `job_effects` attributes it all to one name, and the
per-worker distribution numbers become meaningless.

**Why not fixed properly.** The real fix is a per-process instance id, which costs the thing
`WORKER_ID` exists for: `w1` in every log line, greppable across terminals. A generated uuid per
process would be correct and unreadable.

**How to see it.** Run `npm run dev:worker` twice without changing `WORKER_ID`. The second prints
`another process is alive as w1 — leaving queueflow:processing:w1 alone`.

---

## GAP-5.6 — The reaper is a single point of failure

**What.** The reaper lives in the scheduler process. Kill it and no dead worker's jobs are ever
recovered — they sit in processing lists indefinitely, with no error anywhere.

**Why left.** Same reasoning as GAP-4.2, and now with higher stakes since the scheduler carries two
recovery duties instead of one. It is safe to run several: `ZREM` decides the retry race, and `LREM`
and `LMOVE` decide the reaping race, both by the same atomicity that keeps two workers off one job.
Nothing coordinates them and nothing needs to.

**How to see it.** Kill the scheduler, then kill a worker mid-job. The id stays in
`queueflow:processing:<id>` forever.

**If it needed fixing.** Run two schedulers, which works today, and alert on the age of the oldest
entry in any processing list.

---

## GAP-5.7 — Idempotency keys are kept forever

**What.** `POST /jobs` with an `Idempotency-Key` stores it against the job permanently. A key reused
a year later still returns the original job.

**Why left.** Real implementations scope keys to a window — Stripe expires them after 24 hours — so
that a key is only promised to deduplicate for as long as a client could plausibly still be retrying.
Doing that here means an expiry column and something to sweep it, and the sweeper is more machinery
than the feature is worth at this size.

**How to see it.**

```bash
curl.exe -X POST http://localhost:4000/jobs -H "Idempotency-Key: k1" -H "Content-Type: application/json" ^
  -d "{\"type\":\"sleep\",\"payload\":{\"ms\":10}}"
```

Run it twice: the second returns `200` with `deduplicated: true` and the first job's id, however much
time has passed.

**Also unhandled.** The same key sent with a *different* payload silently returns the original job
rather than rejecting the mismatch, which is what a stricter implementation would do.

---

## GAP-5.8 — Losing Redis strands `running` and `retrying` rows permanently

**What.** Every recovery path in this system is triggered by something *in Redis*. `reapDead` starts
by `SCAN`ning for `queueflow:processing:*` keys and works through whatever it finds. `sweepOrphans`
starts from Postgres, but only looks at `WHERE status = 'queued'`.

So if Redis goes away — an eviction, a restart without persistence, a `FLUSHALL`, a container
recreated without its volume — the two recovery mechanisms disagree about who is responsible for
what, and two kinds of row fall through the gap between them:

- **`running`.** The processing list that named the job is gone, so `reapDead` has nothing to scan
  and never learns the job existed. `sweepOrphans` skips it because its status is not `queued`. The
  row stays `running` forever, against a worker that may not exist any more.
- **`retrying`.** The row is waiting on a score in `queueflow:delayed` for the scheduler to promote
  it. That ZSET is gone too, so the promotion never comes, and `reapWorker` explicitly treats
  `retrying` as *already accounted for* — it assumes the ZSET entry exists. Nothing will ever look
  at the row again.

`queued` rows survive this, because that is exactly the case `sweepOrphans` was written for: the row
says queued, nothing in Redis holds the id, push it back. The design is asymmetric because the
*original* failure it was written for is asymmetric — the API crashing between the INSERT and the
LPUSH only ever produces `queued` rows. Redis vanishing produces all three.

**Why left.** Fixing it means the orphan sweep stops asking "is this row queued?" and starts asking
"does Redis still hold this id?" for `running` and `retrying` rows too. That check is only safe when
it is *certain* Redis is intact — otherwise a momentary connection failure looks identical to a wipe,
and a sweep that trusted it would yank live jobs out of workers that are running them fine. The
honest version needs an epoch or a generation marker in Redis so the scheduler can tell "empty
because nothing is queued" from "empty because this is a different Redis than the one that was here a
minute ago". That is a real piece of design, not a patch, and it belongs with the persistence
decisions rather than bolted on here.

The operational answer in the meantime is the cheaper one: **do not run Redis in a container without a
volume**, which is why `docker-compose.prod.yml` gives it a named volume and AOF.

**How to see it.**

```bash
# a job that will take a while, so it is genuinely mid-flight
curl.exe -X POST http://localhost:4000/api/jobs -H "Content-Type: application/json" ^
  -d "{\"type\":\"sleep\",\"payload\":{\"ms\":60000}}"

# confirm it is running, then take Redis away underneath it
docker compose exec redis redis-cli FLUSHALL
```

Wait past `ORPHAN_AGE_S` and the heartbeat TTL, with the scheduler running the whole time. The row
stays `running`, the scheduler logs nothing, and no amount of waiting changes either. `GET /api/jobs`
keeps reporting it as in progress.

**Also worth knowing.** The seed data in `docs-no-commit` is this gap on purpose: it writes
`retrying` rows with no matching ZSET entry, which is the same stranded state, reached by a different
route. They sit there permanently, which is what makes them useful as demo rows and is also the point
of this gap.
