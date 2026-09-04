import { randomUUID } from "node:crypto";
import express from "express";
import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { isJobType, type Job } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 4000);

const log = createLogger("api");
const redis = createRedis("api", log);

const app = express();
app.use(express.json());

/**
 * POST /jobs — the producer.
 *
 * Read this handler for what it does NOT do. It does not run the job. It does not
 * wait for the job. It has no way of learning whether the job later succeeded, and
 * it does not keep a reference to it. It writes a string to a Redis list and
 * returns.
 *
 * That asymmetry is the entire idea. A synchronous endpoint holds the HTTP
 * connection open for as long as the work takes, which means the client's timeout
 * governs how long your work is allowed to be, and a client that hangs up
 * mid-request destroys the work. Here the work is decoupled from the request that
 * asked for it: the request finishes in ~1ms, the work happens later, elsewhere,
 * in a different process, and survives the client leaving.
 *
 * Hence 202 Accepted, not 200 OK. 200 means "here is the result of what you asked
 * for". We do not have a result — we have a promise to try. 202 is the status code
 * that means exactly "I have taken responsibility for this, and I am not done".
 * Returning 200 here would be a lie the client cannot detect.
 */
app.post("/jobs", async (req, res) => {
  const { type, payload } = req.body ?? {};

  if (!isJobType(type)) {
    return res.status(400).json({ error: `unknown job type: ${String(type)}` });
  }
  if (type === "sleep" && typeof payload?.ms !== "number") {
    return res.status(400).json({ error: "sleep requires payload.ms (number)" });
  }

  const job: Job = {
    id: randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  };

  /**
   * LPUSH pushes onto the LEFT (head) of the list; the worker pops from the RIGHT
   * (tail). Opposite ends is what makes this list a FIFO queue rather than a
   * stack — the oldest job is always the one furthest from where new ones arrive.
   *
   * Note what is stored: the whole job, serialised. project.md's key layout says
   * Redis should hold only the id, with the payload in Postgres — that is the
   * Phase 2 shape. There is no Postgres yet, so an id alone would leave the worker
   * holding a string it cannot act on. Phase 2's real work is exactly this split.
   */
  await redis.lpush(KEYS.pending, JSON.stringify(job));

  log.info(job.id, `queued (${job.type})`);

  return res.status(202).json({ jobId: job.id, status: "queued" });
});

/**
 * Liveness of the dependency, not of this process. If Express can answer at all
 * then Express is fine; what a caller actually needs to know is whether the queue
 * behind it is reachable, because an API that accepts jobs it cannot enqueue is
 * worse than one that is honestly down.
 */
app.get("/health", async (_req, res) => {
  try {
    const pong = await redis.ping();
    const depth = await redis.llen(KEYS.pending);
    return res.json({ status: "ok", redis: pong, pending: depth });
  } catch (err) {
    return res.status(503).json({
      status: "degraded",
      redis: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  log.info(null, `listening on http://localhost:${PORT}`);
});
