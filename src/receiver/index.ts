import express from "express";
import { createLogger } from "../shared/log.js";

// Test webhook receiver and failure simulator.
// Used to demonstrate QueueFlow behavior from an external service's perspective.
// Run with: npm run dev:receiver

const PORT = Number(process.env.RECEIVER_PORT ?? 4001);

const log = createLogger("recv");
const app = express();
app.use(express.json());

// Count how many times each job was delivered.
const deliveries = new Map<string, number>();

// Track jobs whose external effect has already been applied.
const applied = new Set<string>();

function record(req: express.Request): { jobId: string; count: number } {
  // Use the stable QueueFlow job ID to identify deliveries.
  const jobId = req.get("X-QueueFlow-Job-Id") ?? "unknown";
  const count = (deliveries.get(jobId) ?? 0) + 1;
  deliveries.set(jobId, count);
  return { jobId, count };
}

// Read an optional response delay, capped at 60 seconds.
function delayFrom(req: express.Request): number {
  const raw = Number(req.query.delayMs);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60_000) : 0;
}

// Always succeeds. Use ?delayMs=N to simulate a slow but healthy receiver.
app.post("/hook", (req, res) => {
  const { jobId, count } = record(req);
  const attempt = req.get("X-QueueFlow-Attempt") ?? "?";
  log.info(jobId, `received (attempt ${attempt}, delivery #${count}) ${JSON.stringify(req.body)}`);
  if (count > 1) log.error(jobId, `DUPLICATE DELIVERY — this job has now arrived ${count} times`);

  // Record the delivery before responding so in-flight duplicates are observable.
  setTimeout(() => res.status(200).json({ ok: true, received: count }), delayFrom(req));
});

// Always succeeds and applies the external effect at most once per job ID.
// Multiple deliveries are accepted, but duplicates become no-ops.
app.post("/hook/idempotent", (req, res) => {
  const { jobId, count } = record(req);
  const delay = delayFrom(req);

  if (applied.has(jobId)) {
    log.info(jobId, `delivery #${count} ignored — already applied, nothing changed`);
    setTimeout(() => res.status(200).json({ ok: true, duplicate: true, received: count }), delay);
    return;
  }

  // Claim the job before the delay so concurrent duplicate deliveries cannot both apply it.
  applied.add(jobId);
  log.info(jobId, `applied (delivery #${count}) ${JSON.stringify(req.body)}`);
  setTimeout(() => res.status(200).json({ ok: true, duplicate: false, received: count }), delay);
});

// Always returns 500 to simulate a receiver outage.
app.post("/hook/down", (req, res) => {
  const { jobId } = record(req);
  log.error(jobId, "responding 500 (simulated outage)");
  res.status(500).json({ error: "simulated outage" });
});

// Keeps the connection open for 60 seconds to simulate a hung receiver.
app.post("/hook/slow", (req, res) => {
  const { jobId } = record(req);
  log.info(jobId, "holding the connection open for 60s (simulated hang)");
  setTimeout(() => res.status(200).json({ ok: true }), 60_000);
});

// Fails the first N deliveries, then succeeds to demonstrate retries.
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

// Show what the external service actually received and applied.
app.get("/deliveries", (_req, res) => {
  res.json({
    total: [...deliveries.values()].reduce((a, b) => a + b, 0),
    applied: applied.size,
    duplicates: [...deliveries.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    byJob: Object.fromEntries(deliveries),
  });
});

// Clear the simulated receiver state.
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