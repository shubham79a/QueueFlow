-- QueueFlow schema.
--
-- Applied by `npm run db:migrate`, which just executes this file. Everything is
-- IF NOT EXISTS so running it twice is harmless and a schema change does not mean
-- destroying the database.

-- ---------------------------------------------------------------------------
-- jobs — the permanent record.
--
-- This is the source of truth. Redis holds job ids and nothing else; if Redis
-- were wiped right now, every job that ever ran would still be here with its
-- payload, its outcome and its timings. That asymmetry is the point of Phase 2:
-- Redis is a transport, this is the record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,

  -- The state machine, enforced by the database rather than by convention.
  -- A bug that tries to write 'suceeded' fails loudly at the INSERT instead of
  -- quietly creating a state nothing queries for.
  --   queued    accepted, waiting for a worker
  --   running   a worker claimed it
  --   succeeded handler returned
  --   failed    handler threw (terminal for now; retries are Phase 4)
  --   dead      exhausted its retries (unused until Phase 4)
  status           TEXT NOT NULL
                     CHECK (status IN ('queued','running','succeeded','failed','dead')),

  attempts         INT  NOT NULL DEFAULT 0,

  -- Unused until Phase 4 (retries) and Phase 5 (idempotency). Declared now
  -- because they are part of the schema this system was specified with, and
  -- adding columns to a table with history in it is churn for no gain.
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
--
-- Built now, before it is needed. In Phase 5 the whole argument for idempotency
-- rests on being able to show a job that ran twice, and you cannot show that
-- with logs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_effects (
  job_id     UUID NOT NULL REFERENCES jobs(id),
  worker_id  TEXT NOT NULL,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_effects_job_id_idx ON job_effects (job_id);
