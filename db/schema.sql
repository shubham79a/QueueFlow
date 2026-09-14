-- QueueFlow schema.
--
-- Applied by `npm run db:migrate`, which just executes this file. Everything is
-- IF NOT EXISTS so running it twice is harmless and a schema change does not mean
-- destroying the database.

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,

  -- The state machine, enforced by the database rather than by convention.
  -- A bug that tries to write 'suceeded' fails loudly at the INSERT instead of
  -- quietly creating a state nothing queries for.
  --   queued     accepted, in Redis, waiting for a worker
  --   running    a worker has claimed it
  --   retrying   failed, parked in the delayed set until its backoff elapses
  --   succeeded  handler returned
  --   failed     reserved for a permanent, non-retryable failure — nothing writes it yet
  --   dead       out of attempts; the dead-letter queue is WHERE status = 'dead'
  --
  -- The CHECK below is the original five; 'retrying' is added by an ALTER further
  -- down, which replaces this constraint with the full six-state version.
  status           TEXT NOT NULL
                     CHECK (status IN ('queued','running','succeeded','failed','dead')),

  attempts         INT  NOT NULL DEFAULT 0,

  max_attempts     INT  NOT NULL DEFAULT 5,
  last_error       TEXT,
  idempotency_key  TEXT UNIQUE,

  -- Three timestamps, not one, because they answer different questions:
  --   started_at - created_at   = how long it waited in the queue  (measures US)
  --   completed_at - started_at = how long the work took           (measures THE WORK)
  -- Conflating those two is the standard benchmarking mistake.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

-- Supports both "show me everything queued" and the orphan query in gaps/phase-2.md.
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- job_effects — the proof table.
--
-- One row per execution, written by the worker that ran it. Nothing in the
-- system reads this; it exists so that correctness is a SQL query instead of an
-- argument about log files:
--
--   -- did anything run twice?
--   SELECT job_id, COUNT(*) FROM job_effects GROUP BY job_id HAVING COUNT(*) > 1;
--
--   -- did anything claim success without running?
--   SELECT id FROM jobs WHERE status = 'succeeded'
--     AND id NOT IN (SELECT job_id FROM job_effects);
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_effects (
  job_id     UUID NOT NULL REFERENCES jobs(id),
  worker_id  TEXT NOT NULL,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_effects_job_id_idx ON job_effects (job_id);

-- ---------------------------------------------------------------------------
-- Retries.
--
-- Appended as idempotent ALTERs rather than edited into the CREATE TABLE above,
-- because this file is executed whole on every `npm run db:migrate` and has to be
-- safe against both a fresh database and one that already holds job history.
-- ---------------------------------------------------------------------------

-- When a retrying job becomes due. NULL for every other status.
-- Duplicates the score held in the queueflow:delayed sorted set on purpose: Redis
-- decides WHEN the job is promoted, this column is how a human asks WHY a job is
-- sitting there and when it will move.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;

-- 'retrying' means: the job failed, has attempts left, and is parked in the
-- delayed set waiting for its backoff to elapse.
--
-- It gets its own status rather than reusing 'queued' so that the two kinds of
-- waiting stay distinguishable. A job in 'queued' is in Redis and will run as soon
-- as a worker is free; a job in 'retrying' is in nobody's queue yet. Collapsing
-- them would also break the orphan query in gaps/phase-2.md, which reports old
-- 'queued' rows as jobs the API failed to enqueue.
--
-- 'failed' stays permitted but is no longer written. It is the slot for a
-- permanent, non-retryable failure if error classification is ever added;
-- 'dead' is what a job reaches after exhausting its attempts.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued','running','retrying','succeeded','failed','dead'));

-- Partial index: only retrying rows have a next_run_at worth looking up.
CREATE INDEX IF NOT EXISTS jobs_next_run_at_idx ON jobs (next_run_at)
  WHERE status = 'retrying';

-- ---------------------------------------------------------------------------
-- Leases.
--
-- Once a job can be RESCUED from a worker that stopped responding, it can also be
-- TAKEN from a worker that was merely slow — those are the same act, and no
-- failure detector can tell the two apart, because over a network a process that
-- has died and one that is quiet look identical.
--
-- So the job will sometimes run twice. This column is what stops it being
-- RECORDED twice.
--
-- A worker claiming a job writes a fresh random value here and keeps a copy. Every
-- later write about that job carries `AND lease_id = <the copy>`. If the job was
-- reassigned in the meantime, the new owner's claim has already overwritten this
-- column, so the old owner's UPDATE matches zero rows: it rolls back, writes no
-- job_effects row, and says so in its log. Whoever holds the current lease is the
-- only one who can speak for the job.
--
-- A COLUMN RATHER THAN A REDIS KEY, deliberately. The obvious alternative is
-- SET NX with an expiry, and it fails at exactly the moment it is needed: the
-- guard would expire during the long, slow execution that caused the trouble in
-- the first place. A row does not expire. It is also the same transaction as the
-- write it is guarding, so there is no window between checking and writing.
--
-- Note what is NOT added here: a UNIQUE constraint on job_effects(job_id). That
-- would make duplicates impossible to record — and job_effects has to stay able to
-- SHOW the duplicate, or the whole argument for this column is unfalsifiable.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_id UUID;

-- Supports the human question "what is running, and since when?" — the query that
-- used to be the only evidence a worker had died.
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (started_at) WHERE status = 'running';
