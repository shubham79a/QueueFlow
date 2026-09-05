# Gaps — Phase 3 (multiple workers and concurrency)

Deliberate omissions. Each says what is missing, why it was left, and how to observe it.

| ID | Gap | Closed by |
| --- | --- | --- |
| GAP-3.1 | No ordering guarantee once concurrency > 1 | not planned — documented |
| GAP-3.2 | One shared slot pool for all job types; slow jobs starve fast ones | not planned |
| GAP-3.3 | No rate limiting toward downstream services | not planned |
| GAP-3.4 | A killed worker now strands up to `CONCURRENCY` jobs, not one | Phase 5 |
| GAP-3.5 | No graceful shutdown, so a deploy strands `workers × concurrency` jobs | Phase 7 |
| GAP-3.6 | Throughput is capped by Postgres commit rate, not by worker capacity | not planned — measured |

---

## GAP-3.1 — No ordering guarantee with concurrency > 1

**What.** Jobs are *started* in FIFO order — `BRPOP` still takes from the tail — but with several in
flight they finish in whatever order they finish. Job 2 can complete before job 1.

**Why left.** Nothing in this system needs ordering, and providing it would mean giving up most of
what concurrency buys. Real queues that need it (per-user, per-entity) partition the work into one
serial stream per key, which is a different design, not a setting.

**How to see it.**
```bash
npm run dev:workers 1        # with CONCURRENCY=5 in .env
# enqueue jobs with descending durations: 5000ms, 4000ms, 3000ms...
```
```sql
SELECT id, completed_at FROM jobs ORDER BY created_at;   -- completed_at not monotonic
```

**If you needed it.** Route by key so all jobs for one entity land on one queue handled serially:
`queueflow:pending:{user_id % N}`. Ordering within a key, concurrency across keys.

---

## GAP-3.2 — One slot pool shared by all job types

**What.** `CONCURRENCY` is global to a worker. Twenty slow `deliver_webhook` jobs fill every slot,
and a `sleep` job that would take 50ms waits behind them.

**Why left.** Fixing it means per-type queues and per-type limits — a scheduling policy, and a
larger piece of design than this phase is about.

**How to see it.** Enqueue 20 webhooks against `/hook/slow` with a 30s timeout, then enqueue a fast
job. It will not start until a webhook slot frees.

**If you needed it.** Separate Redis lists per class with their own worker pools, so a slow class
cannot consume the capacity of a fast one.

---

## GAP-3.3 — No rate limiting toward downstream

**What.** Concurrency is bounded only by configuration. 3 workers × 20 concurrency = 60 requests in
flight at a receiver that may allow 10 per second.

**Why left.** The limit belongs to the downstream service, not to this queue, and implementing it
properly means a shared token bucket in Redis — every worker drawing from one budget. Worth doing
deliberately rather than as a footnote.

**Why it matters.** From `project.md`: *"If the downstream API allows 10 req/s I have built an
efficient way to get rate limited."* Concurrency past what the receiver can serve produces more
in-flight requests, more 429s, and no more completed work.

**How to see it.** Point 60 concurrent `deliver_webhook` jobs at `/hook/slow` and watch in-flight
requests climb while throughput does not.

---

## GAP-3.4 — A killed worker now strands `CONCURRENCY` jobs, not one

**What.** [GAP-2.2](phase-2.md) said a worker killed mid-job leaves its row at `running` forever.
With concurrency, it leaves up to `CONCURRENCY` rows that way.

**Why this is stated plainly.** This phase made an existing problem *worse*. Concurrency is not a
free win — it multiplies the blast radius of every unrecovered failure, and presenting it as pure
upside would be dishonest.

**What limits the damage.** A slot is acquired *before* `BRPOP`, so a job leaves Redis only when a
worker is ready to run it immediately. The worst case is exactly `CONCURRENCY` — the jobs actually
in flight — rather than everything the worker could have buffered.

**How to see it.**
```bash
npm run dev:workers 1        # CONCURRENCY=5
# enqueue 5 × 20s jobs, wait for all to start, then hard-kill the worker
```
```sql
SELECT COUNT(*) FROM jobs WHERE status = 'running';   -- 5, and they stay that way
```

**Closed by.** Phase 5 — `BLMOVE` into a per-worker processing list, heartbeat, reaper.

---

## GAP-3.5 — No graceful shutdown

**What.** `SIGTERM` kills the process immediately, including every in-flight job. With three
workers at concurrency 20, one deploy strands up to 60 jobs.

**Why left.** Phase 7. It is a small change — stop acquiring slots, wait for `slots.inFlight` to
reach zero, exit — and `Semaphore.inFlight` exists partly for it.

**Closed by.** Phase 7.

---

## GAP-3.6 — Throughput is capped by Postgres, not by workers

**What.** Measured on this machine with `npm run bench`, using 1ms jobs so that per-job overhead
dominates rather than the sleep:

```text
workers  conc   slots   jobs/s
      3     5      15     922.6
      3    20      60    1039.7      4× the slots, +13% throughput
```

Adding capacity stopped helping. Measuring the dependencies directly explains why:

| Dependency | Measured | Ops per job | Implied ceiling |
| --- | --- | --- | --- |
| Redis `LPUSH` + `RPOP` | 8,701/s | 2 | ~4,350 jobs/s |
| Postgres reads | 11,612/s | 1 | ~11,600 jobs/s |
| **Postgres writes** | **3,591/s** | **3** | **~1,197 jobs/s** |

Observed ceiling of 1,039 jobs/s is 87% of the write-limited prediction, so **the bottleneck is
Postgres commit throughput**. Each job performs three durable writes — the claim, the `job_effects`
row, and the terminal status — and each must be committed to disk.

**Why left.** It is not a defect; it is where the limit currently sits, and knowing that is the
point of measuring. It would only be worth attacking with evidence that this rate is insufficient.

**If it needed fixing.** Batch the status writes rather than committing per job; drop to one write
per job by combining the claim and the effect row; or relax durability with
`synchronous_commit = off`, accepting the loss of recently committed rows on a database crash.

**The line worth being able to say.** *"Throughput plateaued around 1,000 jobs/s because the
bottleneck moved off the workers and onto Postgres commit rate — three durable writes per job
against a measured 3,600 writes per second."*
