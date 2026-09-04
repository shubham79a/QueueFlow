import { KEYS } from "../shared/keys.js";
import { createLogger } from "../shared/log.js";
import { createRedis } from "../shared/redis.js";
import { parseJob } from "../shared/types.js";
import { handlers } from "./handlers.js";

const WORKER_ID = process.env.WORKER_ID ?? "w1";

const log = createLogger(WORKER_ID);

/**
 * This connection exists to do one thing: block on the queue.
 *
 * BRPOP does not return until a job arrives, and while it is outstanding the
 * connection is parked server-side and cannot carry another command. Anything else
 * this process wants to ask Redis — a heartbeat SET, an LLEN, a metrics read —
 * would sit behind the blocked call and not run until a job happened to arrive,
 * which is the opposite of what a heartbeat is for.
 *
 * So: one connection for blocking, a second for everything else. Phase 5 is where
 * the second one earns its keep (heartbeats). It is named here so the constraint
 * is visible now rather than discovered later.
 */
const blocking = createRedis(`${WORKER_ID}:blocking`, log);

async function processOne(raw: string): Promise<void> {
  const job = parseJob(raw);

  if (!job) {
    // Bad data, not a bug in this worker. Log it and stay alive.
    log.error(null, `discarded unparseable entry: ${raw.slice(0, 120)}`);
    return;
  }

  try {
    await handlers[job.type](job, log);
  } catch (err) {
    /**
     * Phase 1's failure handling, in full: say so, and move on.
     *
     * The job is already gone from Redis — BRPOP removed it — so there is nothing
     * to put back and no record anywhere that it existed. A transient blip and a
     * permanent bug are treated identically: both destroy the job.
     *
     * Do not fix this here. Retries, backoff and the dead-letter queue are Phase 4,
     * and they only make sense once you have watched a job die this way.
     */
    log.error(job.id, `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  log.info(null, `worker ${WORKER_ID} up, waiting on ${KEYS.pending}`);

  while (true) {
    /**
     * BRPOP — Blocking Right POP — rather than polling with LPOP in a loop.
     *
     * Polling forces a choice between two bad options. Poll every 100ms and you
     * send 864,000 pointless round-trips a day to be told "nothing", each one
     * burning a little CPU on both ends. Poll every 5s to avoid that and you have
     * added up to 5 seconds of latency to a job that was ready immediately.
     * Blocking removes the trade-off: Redis parks the connection and answers the
     * instant something is pushed. Zero commands while idle, zero added latency.
     *
     * The `0` is the timeout in seconds, and 0 means "never time out".
     *
     * Return shape is [key, value] — the key comes back because BRPOP can watch
     * several lists at once and you would otherwise not know which one fired.
     *
     * NOW THE PART THAT MATTERS, and the reason Phase 5 exists:
     *
     * BRPOP *removes* the job. The instant this line returns, the only copy of
     * that job is a local variable inside this process. Redis has forgotten it.
     * Nothing on disk, nothing in another process, no record that it was ever
     * accepted. If this process dies one millisecond from now, the job does not
     * fail — it never happened, and nobody can find out that it didn't.
     *
     * Phase 5 replaces this line with BLMOVE, which pops and pushes to a
     * per-worker "processing" list in a single atomic step, so a crashed worker
     * leaves its job sitting somewhere a reaper can find it. Build the broken
     * version first and go break it on purpose — see the README.
     */
    const result = await blocking.brpop(KEYS.pending, 0);

    if (!result) continue; // only on timeout, which cannot happen with 0.

    const [, raw] = result;

    /**
     * Awaited, not fired-and-forgotten. This worker runs exactly one job at a
     * time: the loop cannot come back around to BRPOP until the handler resolves.
     *
     * That is a real ceiling — a 5-second job means at most 12 jobs a minute out
     * of this process no matter how many are waiting — and it is intentional.
     * Making it faster is Phase 3 (more workers) and the concurrency question that
     * comes with it.
     */
    await processOne(raw);
  }
}

main().catch((err) => {
  log.error(null, `fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
