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
 * received. When those two disagree, the disagreement is the bug — and in Phase 5
 * this counter is what will show a webhook being delivered twice.
 */
const deliveries = new Map<string, number>();

function record(req: express.Request): { jobId: string; count: number } {
  // Real webhook senders identify each delivery this way — GitHub sends
  // X-GitHub-Delivery, Stripe sends an idempotency key on the request.
  const jobId = req.get("X-QueueFlow-Job-Id") ?? "unknown";
  const count = (deliveries.get(jobId) ?? 0) + 1;
  deliveries.set(jobId, count);
  return { jobId, count };
}

/** Always succeeds. */
app.post("/hook", (req, res) => {
  const { jobId, count } = record(req);
  const attempt = req.get("X-QueueFlow-Attempt") ?? "?";
  log.info(jobId, `received (attempt ${attempt}, delivery #${count}) ${JSON.stringify(req.body)}`);
  if (count > 1) log.error(jobId, `DUPLICATE DELIVERY — this job has now arrived ${count} times`);
  res.status(200).json({ ok: true, received: count });
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
 * and is now fine. It is unreachable today, because a failed job is never retried.
 * In Phase 4 it becomes the demonstration: watch attempts climb 1, 2, 3 with
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

/** What has actually arrived here. The outside world's version of events. */
app.get("/deliveries", (_req, res) => {
  res.json({
    total: [...deliveries.values()].reduce((a, b) => a + b, 0),
    duplicates: [...deliveries.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    byJob: Object.fromEntries(deliveries),
  });
});

app.delete("/deliveries", (_req, res) => {
  deliveries.clear();
  log.info(null, "delivery log cleared");
  res.json({ ok: true });
});

app.listen(PORT, () => {
  log.info(null, `webhook receiver on http://localhost:${PORT}`);
  log.info(null, `  POST /hook              always succeeds`);
  log.info(null, `  POST /hook/down         always 500`);
  log.info(null, `  POST /hook/slow         hangs for 60s`);
  log.info(null, `  POST /hook/flaky/:n     fails n times per job, then succeeds`);
  log.info(null, `  GET  /deliveries        what actually arrived`);
});
