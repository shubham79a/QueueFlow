# Gaps — Phase 1 (basic queue)

Written retroactively. Phase 1 was an HTTP producer, a Redis list, and one worker.

| ID | Gap | Status |
| --- | --- | --- |
| GAP-1.1 | No persistence — a job existed only while queued | **closed by Phase 2** |
| GAP-1.2 | No way to ask about a job's status | **closed by Phase 2** |
| GAP-1.3 | A worker killed mid-job destroyed the job with no trace | partly — see GAP-2.2 |
| GAP-1.4 | No retries, backoff or dead-letter queue | open — see GAP-2.3 |
| GAP-1.5 | One job in flight per worker; one worker | open, Phase 3 |
| GAP-1.6 | No graceful shutdown | open — see GAP-2.6 |

---

## GAP-1.1 — No persistence · CLOSED

**What.** The job existed as a JSON string inside a Redis list and nowhere else. Once a worker
popped it, no record of it survived anywhere in the system.

**Closed by.** Phase 2. `db/schema.sql` adds the `jobs` table, and the API writes the row before
enqueuing the id.

---

## GAP-1.2 — No job status endpoint · CLOSED

**What.** `GET /jobs/:id` was impossible to write. A job inside a Redis list has no address — you
cannot ask a list about one entry without scanning all of it, and after a worker popped it there
was nothing to scan.

**Closed by.** Phase 2. A row has a primary key, so the question has an answer — and keeps having
one long after the job finished.

---

## GAP-1.3 — A killed worker destroyed the job · PARTLY CLOSED

**What.** `BRPOP` removes the entry at handoff, so between the pop and the job finishing, the only
copy in existence was a local variable in that process.

**How it looked.** After `taskkill /F` on a mid-job worker: `LLEN queueflow:pending` → `0`, and
`KEYS '*'` → empty. The client already held a `202`. Nothing anywhere recorded the job.

**Now.** The job is still lost, but it is no longer invisible — the row sits at `running` with a
`started_at` and no `completed_at`. Visibility was Phase 2's half of this. Recovery is
[GAP-2.2](phase-2.md), and closes in Phase 5.

---

## GAP-1.4 · GAP-1.5 · GAP-1.6 — still open

Carried forward as [GAP-2.3](phase-2.md) (retries), Phase 3 (concurrency), and
[GAP-2.6](phase-2.md) (graceful shutdown).
