# API

Every route, paging, auth and idempotency. Back to the [README](../README.md).

### API

All routes are under `/api`; everything else is the dashboard.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/jobs` | **write** | Submit work. Returns `202` with the job id |
| `POST /api/jobs/:id/replay` | **write** | Requeue a dead job. `409` unless it is dead |
| `GET /api/jobs/:id` | open | Full record: status, attempts, error, timings |
| `GET /api/jobs?status=&limit=&cursor=` | open | A page of jobs, newest first |
| `GET /api/workers` | open | Live workers, heartbeat TTL remaining, and what each is holding |
| `GET /api/health` | open | Redis and Postgres reachability, pending/delayed depth, status tally |
| `POST /api/auth/login` | — | Password → session cookie. `401` wrong, `429` throttled |
| `POST /api/auth/logout` | — | Clears the cookie |
| `GET /api/auth/me` | open | Whether this browser is signed in, and whether login is configured |

**Paging.** `GET /api/jobs` returns `{ jobs, nextCursor }`. Pass `nextCursor` back as `?cursor=` for
the next page; `null` means there are no more. The cursor is opaque — do not parse it.

```bash
curl "http://localhost:4000/api/jobs?limit=20"                 # → { jobs: [...], nextCursor: "eyJ0..." }
curl "http://localhost:4000/api/jobs?limit=20&cursor=eyJ0..."  # → the next 20
```

It is a **keyset** cursor, not an offset, and the reason is that this list grows while you read it.
`OFFSET 20` means "skip twenty positions" — so if four jobs arrive between fetching page one and
page two, everything shifts down four and page two repeats four rows you have already seen.
Deletions cause the mirror image: rows skipped silently. A cursor names a *value* — `(created_at,
id)` — and inserting rows above it cannot move it.

The `id` is in the cursor as a tie-breaker, not as the key. Ids are UUIDv4, so their order has
nothing to do with insertion order; but two rows can share a `created_at`, and then a cursor of
`< created_at` drops one while `<=` returns one twice.

**Authentication.** Reading is always open, so the dashboard is viewable by anyone. Writing takes
either of two proofs, because there are two kinds of caller:

| Caller | Proof | Why |
| --- | --- | --- |
| a machine — cron, another service | `Authorization: Bearer <api key>` | a browser cannot hold a key secret |
| you, in the dashboard | session cookie, from the password | a cron has no browser to log in with |

```bash
npm run key:new          # prints qf_… — use it for API_KEYS, ADMIN_PASSWORD and SESSION_SECRET
```

```
API_KEYS=qf_…            comma-separated for more than one machine client
ADMIN_PASSWORD=qf_…      unlocks the dashboard's actions; empty hides the Sign in button
SESSION_SECRET=qf_…      signs the cookie; without it every restart signs you out
```

Both secrets are compared in constant time and neither is ever logged. The session cookie is
`httpOnly` (JavaScript cannot read it, so an XSS cannot steal it), `sameSite=lax`, `secure` over
HTTPS, and valid 12 hours. Login is throttled to 5 failed attempts per IP per 15 minutes.

**With neither `API_KEYS` nor `ADMIN_PASSWORD` set the write routes are open** — so a fresh clone
runs with no setup — and the API says so loudly at startup. Set at least one before deploying
anywhere reachable: `deliver_webhook` means an open `POST /api/jobs` lets a stranger make your
server send requests to any URL.

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
worker](internals.md#surviving-a-dead-worker), which is about the other one.

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

