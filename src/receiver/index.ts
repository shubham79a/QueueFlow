import express from "express";
import { createLogger } from "../shared/log.js";

/**
 * A stand-in for someone else's server.
 *
 * Real webhook delivery fails for reasons you do not control: the receiver is
 * down, slow, or returns a 500. This process exists so those failures can be
 * produced on demand instead of waited for, and so a delivery can be observed
 * landing from OUTSIDE the queue — independent evidence, not the queue's own
 * account of itself.
 *
 * Run it with: npm run dev:receiver
 */
const PORT = Number(process.env.RECEIVER_PORT ?? 4001);

const log = createLogger("recv");
const app = express();
app.use(express.json());

/**
 * How many times each job has been delivered here.
 *
 * This is the second half of the correctness story. job_effects records what the
 * WORKER believes happened; this records what the outside world actually
 * received. When those two disagree, the disagreement is the bug — and this
 * counter is what shows a webhook being delivered twice.
 */
const deliveries = new Map<string, number>();

/**
 * Which jobs have actually had their EFFECT applied here.
 *
 * The distinction between this and `deliveries` is the entire point of the
 * idempotent endpoint below. `deliveries` counts requests that ARRIVED; this
 * counts requests that CHANGED SOMETHING. A receiver that keeps a record like this
 * turns a repeated delivery into a no-op, which is the only thing anywhere that
 * can make a repeat harmless — because by the time a duplicate is sent, the sender
 * has already lost the ability to prevent it.
 */
const applied = new Set<string>();

function record(req: express.Request): { jobId: string; count: number } {
  // Real webhook senders identify each delivery this way — GitHub sends
  // X-GitHub-Delivery, Stripe sends an idempotency key on the request.
  const jobId = req.get("X-QueueFlow-Job-Id") ?? "unknown";
  const count = (deliveries.get(jobId) ?? 0) + 1;
  deliveries.set(jobId, count);
  return { jobId, count };
}

/**
 * How long to take before answering, from `?delayMs=`.
 *
 * A receiver that works but is SLOW is a different thing from one that is down or
 * hung, and it is the interesting one: it is what keeps a worker busy long enough
 * to be mistaken for dead. Capped so a typo cannot wedge the process.
 */
function delayFrom(req: express.Request): number {
  const raw = Number(req.query.delayMs);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60_000) : 0;
}

/** Always succeeds. Add ?delayMs=N to make it succeed slowly. */
app.post("/hook", (req, res) => {
  const { jobId, count } = record(req);
  const attempt = req.get("X-QueueFlow-Attempt") ?? "?";
  log.info(jobId, `received (attempt ${attempt}, delivery #${count}) ${JSON.stringify(req.body)}`);
  if (count > 1) log.error(jobId, `DUPLICATE DELIVERY — this job has now arrived ${count} times`);

  // Counted on arrival, answered late — so a delivery that is still in flight has
  // already been recorded. That ordering matters: it is what lets a test see the
  // second delivery before the first has been replied to.
  setTimeout(() => res.status(200).json({ ok: true, received: count }), delayFrom(req));
});

/**
 * Always succeeds, and applies its effect AT MOST ONCE per job id.
 *
 * THIS IS THE ONLY PLACE IN THE WHOLE SYSTEM WHERE A DUPLICATE CAN ACTUALLY BE
 * STOPPED, and it is not in the queue. By the time a webhook is delivered a second
 * time, the sender has already lost: it sent the first one, it was told nothing
 * useful, and it cannot reach into this process and take it back. The queue can
 * make sure only one worker RECORDS the result — that is what the lease does — but
 * the request had already left the building.
 *
 * So the duplicate is stopped here, by the party that can: the receiver remembers
 * the id it was given and refuses to apply the same one twice. `X-QueueFlow-Job-Id`
 * is stable across every attempt of a job, which is what makes it usable as the
 * key. GitHub sends X-GitHub-Delivery for this; Stripe asks you to send its
 * idempotency key back.
 *
 * Compare /hook against this one in GET /deliveries: the same three arrivals, and
 * either three effects or one.
 *
 *   "Exactly-once delivery is impossible. You get at-least-once delivery plus an
 *    idempotent consumer, which produces an exactly-once effect."
 *
 * That sentence is a description of these fourteen lines.
 */
app.post("/hook/idempotent", (req, res) => {
  const { jobId, count } = record(req);
  const delay = delayFrom(req);

  if (applied.has(jobId)) {
    log.info(jobId, `delivery #${count} ignored — already applied, nothing changed`);
    setTimeout(() => res.status(200).json({ ok: true, duplicate: true, received: count }), delay);
    return;
  }

  /**
   * Claimed BEFORE the delay, not after.
   *
   * If the id were only recorded once the work finished, two deliveries arriving
   * while the first was still in progress would both find the set empty and both
   * apply. That is the same read-then-write race the API's replay endpoint avoids
   * by putting its condition inside the UPDATE, and a receiver processing slowly
   * is exactly when duplicates show up.
   */
  applied.add(jobId);
  log.info(jobId, `applied (delivery #${count}) ${JSON.stringify(req.body)}`);
  setTimeout(() => res.status(200).json({ ok: true, duplicate: false, received: count }), delay);
});

/** Always returns 500 — the receiver is broken. */
app.post("/hook/down", (req, res) => {
  const { jobId } = record(req);
  log.error(jobId, "responding 500 (simulated outage)");
  res.status(500).json({ error: "simulated outage" });
});

/** Never answers in time — the receiver is hung, not down. A different failure. */
app.post("/hook/slow", (req, res) => {
  const { jobId } = record(req);
  log.info(jobId, "holding the connection open for 60s (simulated hang)");
  setTimeout(() => res.status(200).json({ ok: true }), 60_000);
});

/**
 * Fails the first N deliveries of a given job, then succeeds.
 *
 * This is the shape of a real transient failure — a service that was restarting
 * and is now fine. It is the retry demonstration: watch attempts climb 1, 2, 3 with
 * widening gaps, and then succeed.
 */
app.post("/hook/flaky/:failures", (req, res) => {
  const { jobId, count } = record(req);
  const failures = Number(req.params.failures);

  if (count <= failures) {
    log.error(jobId, `responding 503 (delivery ${count} of ${failures} to fail)`);
    return res.status(503).json({ error: "try again later" });
  }

  log.info(jobId, `recovered on delivery ${count}`);
  return res.status(200).json({ ok: true, recoveredAfter: failures });
});

/**
 * What has actually arrived here. The outside world's version of events.
 *
 * `total` counts requests that arrived; `applied` counts jobs whose effect was
 * carried out. On /hook those two numbers are the same and both climb with every
 * duplicate. On /hook/idempotent they diverge, and the gap between them is the
 * duplicate being absorbed.
 */
app.get("/deliveries", (_req, res) => {
  res.json({
    total: [...deliveries.values()].reduce((a, b) => a + b, 0),
    applied: applied.size,
    duplicates: [...deliveries.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    byJob: Object.fromEntries(deliveries),
  });
});

app.delete("/deliveries", (_req, res) => {
  deliveries.clear();
  applied.clear();
  log.info(null, "delivery log cleared");
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log.info(null, `webhook receiver on http://localhost:${PORT}`);
  log.info(null, `  POST /hook              always succeeds`);
  log.info(null, `  POST /hook/idempotent   succeeds, but applies each job id once`);
  log.info(null, `  POST /hook/down         always 500`);
  log.info(null, `  POST /hook/slow         hangs for 60s`);
  log.info(null, `  POST /hook/flaky/:n     fails n times per job, then succeeds`);
  log.info(null, `  GET  /deliveries        what actually arrived`);
});
