import { Redis } from "ioredis";
import { Pool } from "pg";
import { KEYS } from "../shared/keys.js";

/**
 * Demo data, for a deployment somebody is about to look at.
 *
 * THE POINT IS NOT TO FILL TABLES. An empty deployment is a dead end — every page
 * reads zero, the jobs table says "press New job" at a visitor whose New job button
 * is disabled because they are not signed in, and the workers page tells them to run
 * a command on a machine they do not have. Four pages, nothing to see, and the one
 * thing this project does better than most is invisible.
 *
 * TWO KINDS OF ROW, AND THE DIFFERENCE MATTERS MORE THAN THE COUNTS.
 *
 * History — succeeded, dead, failed — is finished work. A row is the whole truth
 * about it, so these are plain INSERTs and nothing else ever touches them.
 *
 * Live state — queued and retrying — is NOT just a row. A queued job is a row AND an
 * id in Redis; a retrying job is a row AND a score in the delayed set. Writing only
 * the row produces something that looks right in the dashboard and is actually
 * stranded: nothing will ever pick it up, and it sits at that status for ever. So
 * these get their Redis half too, and then they are genuinely live — workers drain
 * the queued ones, the scheduler promotes the retrying ones when they come due, and
 * a visitor watching the page sees real work move rather than a screenshot.
 *
 * `running` is deliberately absent. It is the one status that cannot be seeded
 * honestly: a running row means a worker is holding the job right now, and inventing
 * one with no worker behind it is exactly the stranded state GAP-5.8 describes —
 * permanently stuck, and reading as broken. It appears on its own within seconds of
 * a worker starting, out of the queued rows below.
 *
 *   npm run seed          add demo data
 *   npm run seed -- wipe  clear everything first
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://queueflow:queueflow@127.0.0.1:5433/queueflow";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const WIPE = process.argv.slice(2).includes("wipe");

// Enough succeeded rows that pagination has several pages and the filter is worth
// using. The rest are sized to be visible rather than realistic — a real system has
// far more history than failure.
const COUNTS = {
  succeeded: 240,
  dead: 60,
  failed: 8,
  retrying: 6,
  queued: 12,
} as const;

const db = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

/**
 * Failure shapes, as (type, payload, error) TRIPLES rather than three parallel lists.
 *
 * This is one SQL fragment because the three have to agree, and picking them
 * independently is how the first version of this file ended up showing an `always_fail`
 * job whose error read "http://127.0.0.1:4001/hook responded 422". Nothing crashes on
 * an incoherent row — it just quietly makes the DLQ, the one page somebody reads
 * closely, describe a system that could not exist.
 *
 * The errors themselves are copied from the handlers' actual throw sites, so they are
 * the strings a real failure produces. A DLQ full of "Error: failed" teaches nobody
 * anything.
 */
const FAILURE_SHAPES = `
  SELECT type, payload, last_error FROM (VALUES
    (1,  'deliver_webhook',
         '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"invoice_id":"inv_8841","amount_cents":24900}}'::jsonb,
         'https://hooks.acme-billing.com/v1/invoices unreachable after 41ms: fetch failed: ECONNREFUSED'),
    (2,  'always_fail',
         '{"message":"receiver config is wrong"}'::jsonb,
         'always_fail: receiver config is wrong'),
    (3,  'deliver_webhook',
         '{"url":"https://api.shipping-partner.io/webhooks/dispatch","body":{"order_id":4471,"carrier":"bluedart"}}'::jsonb,
         'https://api.shipping-partner.io/webhooks/dispatch responded 503 after 1204ms: {"error":"upstream unavailable","retry_after":30}'),
    (4,  'deliver_webhook',
         '{"url":"https://hooks.acme-billing.com/v1/refunds","timeoutMs":2000,"body":{"refund_id":"rf_207"}}'::jsonb,
         'https://hooks.acme-billing.com/v1/refunds timed out after 2000ms: The operation was aborted'),
    (5,  'deliver_webhook',
         '{"url":"https://notify.internal.acme.dev/events","body":{"event":"order.created","order_id":5120}}'::jsonb,
         'https://notify.internal.acme.dev/events responded 422 after 87ms: {"error":"payload missing customer_id"}'),
    (6,  'deliver_webhook',
         '{"url":"https://api.shipping-partner.io/webhooks/dispatch","body":{"order_id":4498,"carrier":"delhivery"}}'::jsonb,
         'https://api.shipping-partner.io/webhooks/dispatch responded 500 after 318ms: {"error":"internal error","trace":"7f2a91"}'),
    (7,  'always_fail',
         '{"message":"downstream contract changed — field customer_ref removed"}'::jsonb,
         'always_fail: downstream contract changed — field customer_ref removed'),
    (8,  'deliver_webhook',
         '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"invoice_id":"inv_9013","amount_cents":118000}}'::jsonb,
         'https://hooks.acme-billing.com/v1/invoices responded 429 after 63ms: {"error":"rate limited","retry_after":60}'),
    (9,  'deliver_webhook',
         '{"url":"https://notify.internal.acme.dev/events","timeoutMs":5000,"body":{"event":"user.suspended","user_id":882}}'::jsonb,
         'https://notify.internal.acme.dev/events timed out after 5000ms: The operation was aborted'),
    (10, 'deliver_webhook',
         '{"url":"https://api.shipping-partner.io/webhooks/label","body":{"order_id":4512,"weight_g":1840}}'::jsonb,
         'https://api.shipping-partner.io/webhooks/label unreachable after 9ms: fetch failed: ENOTFOUND'),
    (11, 'deliver_webhook',
         '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"invoice_id":"inv_9102","amount_cents":7350}}'::jsonb,
         'https://hooks.acme-billing.com/v1/invoices responded 401 after 52ms: {"error":"signing key rotated"}'),
    (12, 'deliver_webhook',
         '{"url":"https://notify.internal.acme.dev/events","body":{"event":"invoice.settled","invoice_id":"inv_8712"}}'::jsonb,
         'https://notify.internal.acme.dev/events responded 502 after 2417ms: <html>502 Bad Gateway</html>')
  ) AS f(n, type, payload, last_error)
  WHERE n = 1 + (i % 12)
`;

/**
 * Types that can plausibly have SUCCEEDED — which excludes always_fail, by definition.
 *
 * The same mistake in the other direction: the first version drew succeeded rows from
 * all three types, so the jobs table showed rows reading `always_fail | succeeded`. A
 * handler named always_fail that reached a terminal success is the kind of detail
 * somebody notices in about two seconds.
 */
const SUCCESS_SHAPES = `
  SELECT type, payload FROM (VALUES
    (1,  'deliver_webhook', '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"invoice_id":"inv_7204","amount_cents":15900}}'::jsonb),
    (2,  'sleep',           '{"ms":900}'::jsonb),
    (3,  'deliver_webhook', '{"url":"https://api.shipping-partner.io/webhooks/dispatch","body":{"order_id":3907,"carrier":"bluedart"}}'::jsonb),
    (4,  'sleep',           '{"ms":2400}'::jsonb),
    (5,  'deliver_webhook', '{"url":"https://notify.internal.acme.dev/events","body":{"event":"order.created","order_id":3912}}'::jsonb),
    (6,  'sleep',           '{"ms":450}'::jsonb),
    (7,  'deliver_webhook', '{"url":"https://hooks.acme-billing.com/v1/receipts","timeoutMs":10000,"body":{"receipt_id":"rc_1180"}}'::jsonb),
    (8,  'sleep',           '{"ms":6000}'::jsonb),
    (9,  'deliver_webhook', '{"url":"https://api.shipping-partner.io/webhooks/label","body":{"order_id":3944,"weight_g":620}}'::jsonb),
    (10, 'sleep',           '{"ms":1500}'::jsonb),
    (11, 'deliver_webhook', '{"url":"https://notify.internal.acme.dev/events","body":{"event":"user.verified","user_id":1407}}'::jsonb),
    (12, 'sleep',           '{"ms":3200}'::jsonb),
    (13, 'deliver_webhook', '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"invoice_id":"inv_7788","amount_cents":4250}}'::jsonb),
    (14, 'sleep',           '{"ms":800}'::jsonb)
  ) AS f(n, type, payload)
  WHERE n = 1 + (i % 14)
`;

async function main(): Promise<void> {
  if (WIPE) {
    // job_effects first — it references jobs.
    await db.query("TRUNCATE job_effects, jobs");
    await redis.del(KEYS.pending, KEYS.delayed);
    console.log("wiped jobs, job_effects, pending and delayed");
  }

  // ---- history -------------------------------------------------------------
  // Spread backwards over a week so `created` reads as a range rather than "all of
  // them, just now", and so the keyset cursor has real distinct timestamps to page on.

  // succeeded, each with the job_effects row that proves it ran. Written in the same
  // statement so the correctness query — succeeded rows with no effect row — stays
  // empty against seeded data too. Seed data that breaks your own invariant is worse
  // than no seed data.
  const succeeded = await db.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO jobs (id, type, payload, status, attempts, max_attempts,
                         created_at, started_at, completed_at)
       SELECT gen_random_uuid(), t.type, t.payload, 'succeeded',
              CASE WHEN i % 17 = 0 THEN 3 WHEN i % 7 = 0 THEN 2 ELSE 1 END, 5,
              c.at, c.at + make_interval(secs => 0.02 + random() * 1.5),
              c.at + make_interval(secs => 0.5 + random() * 9)
         FROM generate_series(1, $1) AS i
         CROSS JOIN LATERAL (${SUCCESS_SHAPES}) t
         CROSS JOIN LATERAL (
           SELECT now() - make_interval(secs => (i * 2400) + floor(random() * 600)::int) AS at
         ) c
       RETURNING id, completed_at
     )
     INSERT INTO job_effects (job_id, worker_id, ran_at)
     SELECT id, (ARRAY['w1','w2','w3'])[1 + floor(random() * 3)::int], completed_at
       FROM inserted
     RETURNING job_id AS id`,
    [COUNTS.succeeded],
  );

  // dead — attempts exhausted. This is what the DLQ page is for, so there are enough
  // for it to need a second page.
  await db.query(
    `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts,
                       last_error, created_at, started_at, completed_at)
     SELECT gen_random_uuid(), f.type, f.payload, 'dead', 5, 5, f.last_error,
            c.at, c.at + make_interval(secs => 0.05),
            c.at + make_interval(secs => 31 + random() * 5)
       FROM generate_series(1, $1) AS i
       CROSS JOIN LATERAL (${FAILURE_SHAPES}) f
       CROSS JOIN LATERAL (
         SELECT now() - make_interval(secs => (i * 8600) + floor(random() * 600)::int) AS at
       ) c`,
    [COUNTS.dead],
  );

  // failed — permanent failure, given up on without exhausting attempts.
  //
  // Nothing in the system writes this today: every error is treated as retryable, so
  // a job that can never succeed still burns all five attempts and lands in 'dead'
  // instead. That is GAP-4.1. The status exists in the schema for when a handler can
  // say "this will never work", and it is seeded here so the filter is not an empty
  // option — but these rows are the one part of this file that does not correspond to
  // anything the running system produces.
  await db.query(
    `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts,
                       last_error, created_at, started_at, completed_at)
     SELECT gen_random_uuid(), 'deliver_webhook', p.payload, 'failed', 1, 5, p.last_error,
            c.at, c.at + make_interval(secs => 0.04), c.at + make_interval(secs => 0.1)
       FROM generate_series(1, $1) AS i
       CROSS JOIN LATERAL (
         SELECT payload, last_error FROM (VALUES
           (1, '{"url":"https://hooks.acme-billing.com/v1/invoices","body":{"event":"invoice.void"}}'::jsonb,
               'https://hooks.acme-billing.com/v1/invoices responded 400 after 34ms: {"error":"unknown event type: invoice.void"}'),
           (2, '{"url":"https://api.shipping-partner.io/webhooks/dispatch","body":{"order_id":null}}'::jsonb,
               'https://api.shipping-partner.io/webhooks/dispatch responded 400 after 19ms: {"error":"order_id must not be null"}'),
           (3, '{"url":"https://notify.internal.acme.dev/events","body":{"event":"user.merged","user_id":"abc"}}'::jsonb,
               'https://notify.internal.acme.dev/events responded 422 after 28ms: {"error":"user_id must be an integer"}'),
           (4, '{"url":"https://hooks.acme-billing.com/v1/receipts","body":{"receipt_id":"rc_0"}}'::jsonb,
               'https://hooks.acme-billing.com/v1/receipts responded 404 after 45ms: {"error":"no such receipt"}')
         ) AS g(n, payload, last_error) WHERE n = 1 + (i % 4)
       ) p
       CROSS JOIN LATERAL (
         SELECT now() - make_interval(secs => (i * 5000) + floor(random() * 400)::int) AS at
       ) c`,
    [COUNTS.failed],
  );

  // ---- live state ----------------------------------------------------------

  // retrying — backing off, with the delayed-set entry that makes the backoff real.
  // Spread over the next few minutes so somebody watching sees them fire one by one
  // rather than all at once.
  //
  // ALWAYS_FAIL, NOT DELIVER_WEBHOOK, AND THE REASON IS NOT COSMETIC.
  //
  // Everything above this line is history: a succeeded or dead row is never executed
  // again, so its url is text on a page and can name a realistic host. These rows are
  // live — the scheduler promotes them and a worker really runs them — so whatever url
  // they carry receives an actual HTTP request from a public deployment. Seeding a
  // plausible-looking domain here would fire unsolicited POSTs at whoever owns it.
  //
  // always_fail needs no url, fails on its own terms, and still demonstrates the whole
  // mechanism: backoff, attempts climbing, and the dead-letter queue at the end.
  const retrying = await db.query<{ id: string; next_run_at: Date }>(
    `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts,
                       last_error, created_at, started_at, next_run_at)
     SELECT gen_random_uuid(), 'always_fail',
            jsonb_build_object('message', m.text),
            'retrying', 1 + (i % 4), 5,
            'always_fail: ' || m.text,
            now() - make_interval(secs => 90 + i * 11),
            now() - make_interval(secs => 85 + i * 11),
            now() + make_interval(secs => 20 + i * 45)
       FROM generate_series(1, $1) AS i
       CROSS JOIN LATERAL (
         SELECT (ARRAY[
           'downstream returned 503, backing off',
           'receiver config is wrong',
           'signing key rotated mid-flight'
         ])[1 + (i % 3)] AS text
       ) m
     RETURNING id, next_run_at`,
    [COUNTS.retrying],
  );

  // The other half. Without this the rows above are stranded: the scheduler promotes
  // from the delayed set, not from the table, so a retrying row it cannot see waits
  // for ever.
  for (const r of retrying.rows) {
    await redis.zadd(KEYS.delayed, r.next_run_at.getTime(), r.id);
  }

  // queued — waiting for a worker, with the id actually in the queue. These are the
  // ones that make the demo move: a running worker drains them, so within seconds
  // 'running' appears on its own and the succeeded count starts climbing.
  //
  // No deliver_webhook here either, for the reason given above the retrying block: a
  // queued job is one a worker is about to actually run, and a url in it becomes a real
  // request to whoever owns that host. sleep and always_fail together still show both
  // paths — jobs succeeding, and jobs backing off into the dead-letter queue.
  //
  // The previous version also handed always_fail a {"ms": N} payload, because the type
  // and the payload were chosen by two different expressions. The handler destructures
  // { message }, so it threw its fallback error instead of the seeded one — the same
  // class of mismatch as the type/error bug, one level down.
  const queued = await db.query<{ id: string }>(
    `INSERT INTO jobs (id, type, payload, status, max_attempts, created_at)
     SELECT gen_random_uuid(), t.type, t.payload, 'queued', 5, now()
       FROM generate_series(1, $1) AS i
       CROSS JOIN LATERAL (
         SELECT type, payload FROM (VALUES
           (0, 'sleep',       jsonb_build_object('ms', 3000)),
           (1, 'sleep',       jsonb_build_object('ms', 7000)),
           (2, 'always_fail', jsonb_build_object('message','downstream returned 503, backing off'))
         ) AS g(n, type, payload) WHERE n = i % 3
       ) t
     RETURNING id`,
    [COUNTS.queued],
  );

  // LPUSH, matching the API — the worker's BLMOVE reads from the other end, so this
  // keeps seeded jobs in the order they were created.
  for (const q of queued.rows) {
    await redis.lpush(KEYS.pending, q.id);
  }

  // ---- report --------------------------------------------------------------
  const tally = await db.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM jobs GROUP BY status ORDER BY status`,
  );

  console.log("\njobs by status");
  for (const row of tally.rows) console.log(`  ${row.status.padEnd(10)} ${row.count}`);
  console.log(`\neffects rows        ${succeeded.rowCount}`);
  console.log(`queueflow:pending   ${await redis.llen(KEYS.pending)}`);
  console.log(`queueflow:delayed   ${await redis.zcard(KEYS.delayed)}`);
  console.log(
    "\nStart a worker and a scheduler to watch the queued and retrying rows move.",
  );

  await redis.quit();
  await db.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  redis.disconnect();
  await db.end().catch(() => undefined);
  process.exit(1);
});
